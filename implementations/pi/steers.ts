import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";

export type SteerTrigger = "run_end" | "turn_end";
export type SteerMode = "blocking" | "async";
export type SteerFailure =
  | "evaluation-failed"
  | "invalid-verdict"
  | "delivery-failed"
  | null;

export interface Steer {
  name: string;
  description: string;
  policy: string;
  trigger: SteerTrigger;
  mode: SteerMode;
  compatibility?: string;
  license?: string;
  metadata?: Record<string, string>;
}

export interface SteersConfig {
  systemPrompt: string;
  steers: Steer[];
  diagnostics: string[];
}

export interface SteerEvaluationRequest {
  system: string;
  user: string;
}

export interface Verdict {
  shouldSteer: boolean;
  message: string | null;
}

export interface LogRecord {
  ts: string;
  sessionId: string;
  steer: string;
  trigger: SteerTrigger;
  mode: SteerMode;
  model: string;
  request: SteerEvaluationRequest;
  response: {
    raw: string;
    verdict: Verdict | null;
  };
  delivery: {
    steered: boolean;
    deliverAs: "steer" | null;
    failure: SteerFailure;
    waitMs: number | null;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VALID_TRIGGERS: SteerTrigger[] = ["run_end", "turn_end"];
const VALID_MODES: SteerMode[] = ["blocking", "async"];
const STEER_FILE_NAME = "STEER.md";
const SYSTEM_FILE_NAME = "SYSTEM.md";
const PI_AI_COMPAT_MODULE = "@earendil-works/pi-ai/compat";
const VERDICT_TOOL_NAME = "steering_verdict";

const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    shouldSteer: { type: "boolean" },
    message: { type: ["string", "null"] },
  },
  required: ["shouldSteer", "message"],
  additionalProperties: false,
} as const;

// Google's responseSchema uses uppercase type names and a nullable flag.
const VERDICT_GOOGLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    shouldSteer: { type: "BOOLEAN" },
    message: { type: "STRING", nullable: true },
  },
  required: ["shouldSteer", "message"],
} as const;

const DEFAULT_SYSTEM_PROMPT = [
  "You evaluate whether a steer should correct an AI agent.",
  "Judge only from the supplied conversation and tool activity.",
  "Intervene only when the issue is specific, actionable, and clearly covered by the policy.",
  "Return only valid JSON with shouldSteer and message.",
  'Use {"shouldSteer":false,"message":null} when no correction is required.',
].join("\n");

const DEFAULT_CONFIG: SteersConfig = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  steers: [],
  diagnostics: [],
};

type JsonRecord = Record<string, unknown>;
type TranscriptMessage = JsonRecord;
type AuthResult = Awaited<
  ReturnType<ModelRegistry["getApiKeyAndHeaders"]>
>;
type NotifyLevel = NonNullable<
  Parameters<ExtensionContext["ui"]["notify"]>[1]
>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSteerTrigger(value: unknown): value is SteerTrigger {
  return (
    typeof value === "string" && VALID_TRIGGERS.includes(value as SteerTrigger)
  );
}

function isSteerMode(value: unknown): value is SteerMode {
  return typeof value === "string" && VALID_MODES.includes(value as SteerMode);
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(
  raw: string,
  source: string,
): { fields: JsonRecord; body: string } {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new ConfigError(
      `${source}: expected a --- frontmatter block followed by the policy body.`,
    );
  }

  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new ConfigError(`${source}: ${document.errors[0]?.message}`);
  }
  const fields = document.toJS() as unknown;
  if (!isRecord(fields)) {
    throw new ConfigError(`${source}: frontmatter must be a YAML mapping.`);
  }

  return { fields, body: match[2] ?? "" };
}

function requiredString(
  value: unknown,
  key: string,
  source: string,
  maxLength?: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `${source}: "${key}" must be a non-empty string; received ${safeJson(value)}.`,
    );
  }
  const result = value.trim();
  if (maxLength !== undefined && result.length > maxLength) {
    throw new ConfigError(
      `${source}: "${key}" has ${result.length} characters; shorten it to ${maxLength} or fewer.`,
    );
  }
  return result;
}

function optionalString(
  value: unknown,
  key: string,
  source: string,
  maxLength?: number,
): string | undefined {
  if (value === undefined) return undefined;
  const result = requiredString(value, key, source, maxLength);
  return result;
}

function optionalMetadata(
  value: unknown,
  source: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ConfigError(`${source}: "metadata" must be a YAML mapping.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new ConfigError(
        `${source}: metadata value "${key}" must be a string; received ${safeJson(item)}.`,
      );
    }
  }
  return value as Record<string, string>;
}

export function parseSteerMarkdown(
  raw: string,
  dirName: string,
  source = `${dirName}/${STEER_FILE_NAME}`,
): Steer {
  const { fields, body } = parseFrontmatter(raw, source);

  const name = requiredString(fields.name, "name", source, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new ConfigError(
      `${source}: "name" must contain lowercase letters, numbers, and single hyphens only; received ${JSON.stringify(name)}.`,
    );
  }
  if (name !== dirName) {
    throw new ConfigError(
      `${source}: "name" must match its parent directory "${dirName}".`,
    );
  }
  const description = requiredString(
    fields.description,
    "description",
    source,
    1024,
  );

  const trigger = fields.trigger;
  if (!isSteerTrigger(trigger)) {
    throw new ConfigError(
      `${source}: "trigger" must be one of: ${VALID_TRIGGERS.join(", ")}; received ${safeJson(trigger)}.`,
    );
  }

  const mode = fields.mode;
  if (!isSteerMode(mode)) {
    throw new ConfigError(
      `${source}: "mode" must be one of: ${VALID_MODES.join(", ")}; received ${safeJson(mode)}.`,
    );
  }

  const compatibility = optionalString(
    fields.compatibility,
    "compatibility",
    source,
    500,
  );
  const license = optionalString(fields.license, "license", source);
  const metadata = optionalMetadata(fields.metadata, source);

  const policy = body.trim();
  if (policy === "") {
    throw new ConfigError(`${source}: the policy body must not be empty.`);
  }

  return {
    name,
    description,
    policy,
    trigger,
    mode,
    compatibility,
    license,
    metadata,
  };
}

export function resolveSteersDirs(
  cwd: string,
  home = homedir(),
  exists: (filePath: string) => boolean = existsSync,
): string[] {
  return [
    path.join(cwd, ".agents", "steers"),
    path.join(cwd, ".pi", "steers"),
    path.join(home, ".agents", "steers"),
    path.join(home, ".pi", "steers"),
  ].filter(exists);
}

export function loadSteersDir(steersDir: string): SteersConfig {
  const systemPath = path.join(steersDir, SYSTEM_FILE_NAME);
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const diagnostics: string[] = [];
  if (existsSync(systemPath)) {
    systemPrompt = readFileSync(systemPath, "utf8").trim();
    if (systemPrompt === "") {
      diagnostics.push(`${systemPath}: system prompt must not be empty.`);
      systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }
  }

  const steers: Steer[] = [];
  const seen = new Set<string>();
  const entries = readdirSync(steersDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const steerPath = path.join(steersDir, entry.name, STEER_FILE_NAME);
    if (!existsSync(steerPath)) continue;

    let steer: Steer;
    try {
      steer = parseSteerMarkdown(
        readFileSync(steerPath, "utf8"),
        entry.name,
        steerPath,
      );
    } catch (error) {
      diagnostics.push(errorMessage(error));
      continue;
    }
    if (seen.has(steer.name)) {
      diagnostics.push(
        `Duplicate steer name "${steer.name}" (${steerPath}). Steer names must be unique.`,
      );
      continue;
    }
    seen.add(steer.name);
    steers.push(steer);
  }

  return { systemPrompt, steers, diagnostics };
}

export function loadSteersConfig(
  cwd: string,
  home = homedir(),
): SteersConfig {
  const steersDirs = resolveSteersDirs(cwd, home);
  if (steersDirs.length === 0) return DEFAULT_CONFIG;

  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  const steers: Steer[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const [index, steersDir] of steersDirs.entries()) {
    const config = loadSteersDir(steersDir);
    if (index === 0) systemPrompt = config.systemPrompt;
    diagnostics.push(...config.diagnostics);
    for (const steer of config.steers) {
      if (seen.has(steer.name)) {
        diagnostics.push(
          `${steersDir}: steer "${steer.name}" is shadowed by a higher-precedence definition.`,
        );
        continue;
      }
      seen.add(steer.name);
      steers.push(steer);
    }
  }
  return { systemPrompt, steers, diagnostics };
}

export function parseVerdict(raw: string): Verdict | null {
  try {
    return normalizeVerdict(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/**
 * Changes the provider payload to request JSON that follows the schema. Some
 * APIs support this. On those APIs, the verdict does not come from free text.
 * On all other APIs, the payload does not change, and the text parser is the
 * fallback.
 */
export function injectVerdictSchema(
  payload: unknown,
  modelApi: string,
): unknown {
  if (!isRecord(payload)) return payload;

  switch (modelApi) {
    case "openai-completions":
      return {
        ...payload,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "verdict",
            strict: true,
            schema: VERDICT_JSON_SCHEMA,
          },
        },
      };
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return {
        ...payload,
        text: {
          ...(isRecord(payload.text) ? payload.text : {}),
          format: {
            type: "json_schema",
            name: "verdict",
            strict: true,
            schema: VERDICT_JSON_SCHEMA,
          },
        },
      };
    case "google-generative-ai":
    case "google-vertex":
      return {
        ...payload,
        config: {
          ...(isRecord(payload.config) ? payload.config : {}),
          responseMimeType: "application/json",
          responseSchema: VERDICT_GOOGLE_SCHEMA,
        },
      };
    case "anthropic-messages":
      // Anthropic has no response_format. A forced tool call carries the schema.
      return {
        ...payload,
        tools: [
          ...(Array.isArray(payload.tools) ? payload.tools : []),
          {
            name: VERDICT_TOOL_NAME,
            description: "Return the steering verdict.",
            input_schema: VERDICT_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: VERDICT_TOOL_NAME },
      };
    default:
      return payload;
  }
}

/**
 * Gets the verdict from a completed response. If the response has the forced
 * tool call, the verdict is in its arguments. If not, the verdict is in the
 * text.
 */
export function verdictFromResponse(content: AssistantMessage["content"]): {
  raw: string;
  verdict: Verdict | null;
} {
  for (const part of content) {
    if (part.type === "toolCall" && part.name === VERDICT_TOOL_NAME) {
      const raw = safeJson(part.arguments);
      return { raw, verdict: normalizeVerdict(part.arguments) };
    }
  }

  const raw = textFromContent(content);
  return { raw, verdict: parseVerdict(raw) };
}

export function createLogRecord(args: {
  ts?: string;
  sessionId: string;
  steer: string;
  trigger: SteerTrigger;
  mode: SteerMode;
  model: string;
  request: SteerEvaluationRequest;
  raw: string;
  verdict: Verdict | null;
  steered: boolean;
  deliverAs: "steer" | null;
  failure: SteerFailure;
  waitMs: number | null;
}): LogRecord {
  return {
    ts: args.ts ?? new Date().toISOString(),
    sessionId: args.sessionId,
    steer: args.steer,
    trigger: args.trigger,
    mode: args.mode,
    model: args.model,
    request: {
      system: args.request.system,
      user: args.request.user,
    },
    response: {
      raw: args.raw,
      verdict: args.verdict
        ? {
            shouldSteer: args.verdict.shouldSteer,
            message: args.verdict.message,
          }
        : null,
    },
    delivery: {
      steered: args.steered,
      deliverAs: args.deliverAs,
      failure: args.failure,
      waitMs: args.waitMs,
    },
  };
}

export function appendLogRecord(cwd: string, record: LogRecord): void {
  const logDir = path.join(cwd, ".pi", "steers", "log");
  mkdirSync(logDir, { recursive: true });

  const safeSessionId = record.sessionId.replace(/[\\/:*?"<>|]/g, "_");
  const logFile = path.join(logDir, `${safeSessionId}.jsonl`);
  appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

export default function steersForPi(pi: ExtensionAPI): void {
  let config: SteersConfig = DEFAULT_CONFIG;
  let turnContext: TranscriptMessage[] = [];

  pi.on("session_start", (_event, ctx) => {
    turnContext = [];
    try {
      config = loadSteersConfig(ctx.cwd);
      for (const diagnostic of config.diagnostics) {
        safeNotify(ctx, `steers: ${diagnostic}`, "warning");
      }
    } catch (error) {
      config = DEFAULT_CONFIG;
      safeNotify(ctx, `steers: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("context", (event) => {
    turnContext = (event.messages as unknown as TranscriptMessage[]).slice();
  });

  pi.on("turn_end", async (event, ctx) => {
    const transcript = [
      ...turnContext,
      event.message as unknown as TranscriptMessage,
      ...(event.toolResults as unknown as TranscriptMessage[]),
    ];
    turnContext = [];
    await runSteersForTrigger(
      pi,
      ctx,
      config,
      "turn_end",
      transcript,
    );
  });

  pi.on("agent_end", async (event, ctx) => {
    await runSteersForTrigger(
      pi,
      ctx,
      config,
      "run_end",
      event.messages as unknown as TranscriptMessage[],
    );
  });
}

async function runSteersForTrigger(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: SteersConfig,
  trigger: SteerTrigger,
  transcript: TranscriptMessage[],
): Promise<void> {
  const steers = config.steers.filter((steer) => steer.trigger === trigger);
  if (steers.length === 0) return;

  const userMessage = renderEvaluationMessages(transcript);
  const blocking: Promise<void>[] = [];

  for (const steer of steers) {
    const evaluation = evaluateSteer(
      pi,
      ctx,
      steer,
      config.systemPrompt,
      userMessage,
    );
    if (steer.mode === "blocking") {
      blocking.push(evaluation);
      continue;
    }

    void evaluation.catch((error) => {
      safeNotify(
        ctx,
        `steers async evaluation failed: ${errorMessage(error)}`,
        "warning",
      );
    });
  }

  await Promise.all(blocking);
}

async function evaluateSteer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  steer: Steer,
  systemPrompt: string,
  userMessage: string,
): Promise<void> {
  const started = Date.now();
  // Get all the values from ctx before the first await. The session can end
  // during the evaluation call. After that, ctx is stale and throws an error.
  const cwd = ctx.cwd;
  const sessionId = getSessionId(ctx);
  const model = modelLabel(ctx);
  const request = buildSteerEvaluationRequest(
    steer,
    systemPrompt,
    userMessage,
  );
  let raw = "";
  let verdict: Verdict | null = null;
  let evaluationFailed = false;

  try {
    const response = await evaluateSteerRequest(ctx, request);
    raw = response.raw;
    verdict = response.verdict;
    evaluationFailed = response.failed;
  } catch (error) {
    raw = `Steer evaluation failed: ${errorMessage(error)}`;
    verdict = null;
    evaluationFailed = true;
  }

  let steered = false;
  let deliverAs: "steer" | null = null;
  let failure: SteerFailure = null;

  if (!verdict) {
    failure = evaluationFailed ? "evaluation-failed" : "invalid-verdict";
  } else if (verdict.shouldSteer) {
    if (verdict.message && deliverSteer(pi, verdict.message)) {
      steered = true;
      deliverAs = "steer";
    } else {
      failure = "delivery-failed";
    }
  }

  const record = createLogRecord({
    sessionId,
    steer: steer.name,
    trigger: steer.trigger,
    mode: steer.mode,
    model,
    request,
    raw,
    verdict,
    steered,
    deliverAs,
    failure,
    waitMs: steer.mode === "blocking" ? Date.now() - started : null,
  });

  try {
    appendLogRecord(cwd, record);
  } catch (error) {
    safeNotify(
      ctx,
      `steers log write failed: ${errorMessage(error)}`,
      "warning",
    );
  }
}

export function buildSteerEvaluationRequest(
  steer: Steer,
  systemPrompt: string,
  userMessage: string,
): SteerEvaluationRequest {
  return {
    system: `${systemPrompt}\n\nSteer policy:\n${steer.policy}`,
    user: userMessage,
  };
}

async function evaluateSteerRequest(
  ctx: ExtensionContext,
  request: SteerEvaluationRequest,
): Promise<{ raw: string; verdict: Verdict | null; failed: boolean }> {
  if (!ctx.model) {
    const raw =
      "Steer evaluation could not start because Pi has no selected model. Select a model, then run the steer again.";
    return { raw, verdict: null, failed: true };
  }

  const auth: AuthResult = await ctx.modelRegistry.getApiKeyAndHeaders(
    ctx.model,
  );
  if (!auth.ok) {
    const raw = `Could not resolve model credentials: ${auth.error}`;
    return { raw, verdict: null, failed: true };
  }

  const userMessage: UserMessage = {
    role: "user",
    content: request.user,
    timestamp: Date.now(),
  };

  const { complete } = await import(PI_AI_COMPAT_MODULE);
  const response = await complete(
    ctx.model,
    { systemPrompt: request.system, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: 700,
      signal: ctx.signal,
      onPayload: (payload: unknown, model: { api: string }) =>
        injectVerdictSchema(payload, model.api),
    },
  );

  // On a provider failure, complete() resolves. It does not reject.
  if (response.stopReason === "error") {
    return {
      raw: `Steer evaluation failed: ${response.errorMessage ?? "unknown provider error"}`,
      verdict: null,
      failed: true,
    };
  }
  return { ...verdictFromResponse(response.content), failed: false };
}

function deliverSteer(pi: ExtensionAPI, message: string): boolean {
  // The "steer" delivery is correct in the two host states. When the agent is
  // busy, the message goes into the queue before the next model call. When the
  // agent is idle, the message starts a new turn. The host wrapper discards
  // async rejections. Only a stale session can throw an error here.
  try {
    pi.sendUserMessage(message, { deliverAs: "steer" });
    return true;
  } catch {
    return false;
  }
}

export function safeNotify(
  ctx: ExtensionContext,
  message: string,
  level: NotifyLevel,
): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // After teardown, ctx can be stale. A failed notification must not crash the run.
  }
}

function normalizeVerdict(value: unknown): Verdict | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "shouldSteer") ||
    !Object.hasOwn(value, "message")
  ) {
    return null;
  }

  if (value.shouldSteer === false && value.message === null) {
    return { shouldSteer: false, message: null };
  }

  if (
    value.shouldSteer === true &&
    typeof value.message === "string" &&
    value.message.trim() !== ""
  ) {
    return { shouldSteer: true, message: value.message };
  }

  return null;
}

export function renderEvaluationMessages(
  messages: TranscriptMessage[],
): string {
  const relevant = messages.filter((message) =>
    ["user", "assistant", "toolResult"].includes(String(message.role)),
  );
  if (relevant.length === 0) return "(no relevant messages)";

  return relevant
    .map((message, index) => `#${index + 1} ${renderMessage(message)}`)
    .join("\n\n");
}

function renderMessage(message: TranscriptMessage): string {
  const role = message.role;

  if (role === "assistant") {
    return `assistant:\n${renderContent(message.content)}`;
  }

  if (role === "toolResult") {
    const toolName =
      typeof message.toolName === "string" ? message.toolName : "unknown";
    const isError = message.isError;
    return `toolResult tool=${toolName} isError=${isError}:\n${renderContent(message.content)}`;
  }

  return `${role}:\n${renderContent(message.content ?? message)}`;
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeJson(content);

  return content.map(renderContentPart).join("\n");
}

function renderContentPart(part: unknown): string {
  if (!isRecord(part)) return safeJson(part);
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "image") {
    const mimeType =
      typeof part.mimeType === "string" ? part.mimeType : "unknown";
    return `[image ${mimeType}]`;
  }
  if (part.type === "toolCall") {
    const name = typeof part.name === "string" ? part.name : "unknown";
    const id = typeof part.id === "string" ? part.id : "unknown";
    return `[tool_call name=${name} id=${id} arguments=${safeJson(part.arguments)}]`;
  }
  if (part.type === "thinking" && typeof part.thinking === "string") {
    return `[thinking]\n${part.thinking}`;
  }

  return safeJson(part);
}

function textFromContent(content: AssistantMessage["content"]): string {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() || "unknown-session";
}

function modelLabel(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return "unknown";

  const provider = model.provider;
  const id = model.id;
  if (provider && id) return `${provider}/${id}`;
  return id ?? provider ?? "unknown";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
