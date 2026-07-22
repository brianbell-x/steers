import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSteerEvaluationRequest,
  ConfigError,
  createLogRecord,
  injectVerdictSchema,
  loadSteersDir,
  loadSteersConfig,
  parseSteerMarkdown,
  parseVerdict,
  renderEvaluationMessages,
  resolveSteersDirs,
  safeNotify,
  verdictFromResponse,
  type LogRecord,
} from "../steers.js";

describe("STEER.md parsing", () => {
  it("parses frontmatter and uses the markdown body as the policy", () => {
    const steer = parseSteerMarkdown(
      [
        "---",
        "name: premature-stop",
        "description: Finds agent runs that stop before the requested result is complete.",
        "trigger: run_end",
        "mode: blocking",
        "---",
        "",
        "## Violation",
        "",
        "Watch premature stops.",
        "",
      ].join("\n"),
      "premature-stop",
    );

    expect(steer).toEqual({
      name: "premature-stop",
      description:
        "Finds agent runs that stop before the requested result is complete.",
      policy: "## Violation\n\nWatch premature stops.",
      trigger: "run_end",
      mode: "blocking",
      compatibility: undefined,
      license: undefined,
      metadata: undefined,
    });
  });

  it("parses standard optional fields and YAML metadata", () => {
    const steer = parseSteerMarkdown(
      [
        "---",
        "name: custom",
        "description: Checks one custom policy.",
        "trigger: turn_end",
        "mode: async",
        "compatibility: Pi 0.80.x; requires REVIEW_MODE=strict.",
        "license: Apache-2.0",
        "metadata:",
        "  example.com/owner: platform",
        "---",
        "Body.",
      ].join("\n"),
      "custom",
    );
    expect(steer.compatibility).toBe(
      "Pi 0.80.x; requires REVIEW_MODE=strict.",
    );
    expect(steer.license).toBe("Apache-2.0");
    expect(steer.metadata).toEqual({ "example.com/owner": "platform" });
  });

  it("rejects invalid names, triggers, modes, bodies, and frontmatter", () => {
    expect(() =>
      parseSteerMarkdown(
        "---\nname: other\ndescription: Policy.\ntrigger: run_end\nmode: async\n---\nBody.",
        "d",
      ),
    ).toThrow(ConfigError);
    expect(() =>
      parseSteerMarkdown(
        "---\nname: d\ndescription: Policy.\ntrigger: tool_result\nmode: async\n---\nBody.",
        "d",
      ),
    ).toThrow(ConfigError);
    expect(() =>
      parseSteerMarkdown(
        "---\nname: d\ndescription: Policy.\ntrigger: run_end\nmode: sync\n---\nBody.",
        "d",
      ),
    ).toThrow(ConfigError);
    expect(() =>
      parseSteerMarkdown(
        "---\nname: d\ndescription: Policy.\ntrigger: run_end\nmode: blocking\n---\n  \n",
        "d",
      ),
    ).toThrow(ConfigError);
    expect(() => parseSteerMarkdown("no frontmatter here", "d")).toThrow(
      ConfigError,
    );
  });

  it("names the source file in validation errors", () => {
    expect(() =>
      parseSteerMarkdown(
        "---\nname: bad-steer\ndescription: Policy.\ntrigger: nope\nmode: blocking\n---\nBody.",
        "bad-steer",
        "/tmp/steers/bad-steer/STEER.md",
      ),
    ).toThrow(/bad-steer\/STEER\.md/);
  });
});

describe("steer directory loading", () => {
  it("loads an optional SYSTEM.md and every STEER.md in sorted order", () => {
    const dir = makeSteersDir({
      "SYSTEM.md": "Custom judge prompt.",
      "beta-steer/STEER.md":
        "---\nname: beta-steer\ndescription: Beta policy.\ntrigger: turn_end\nmode: async\n---\nWatch unsupported claims.",
      "alpha-steer/STEER.md":
        "---\nname: alpha-steer\ndescription: Alpha policy.\ntrigger: run_end\nmode: blocking\n---\nDemand citations or deletion.",
      "drafts/notes.txt": "no STEER.md here, ignored",
    });

    const config = loadSteersDir(dir);
    expect(config.systemPrompt).toBe("Custom judge prompt.");
    expect(config.steers.map((steer) => steer.name)).toEqual([
      "alpha-steer",
      "beta-steer",
    ]);
  });

  it("uses the default judge prompt and reports an empty override", () => {
    const missing = makeSteersDir({
      "a/STEER.md":
        "---\nname: a\ndescription: Policy.\ntrigger: turn_end\nmode: async\n---\nPolicy.",
    });
    expect(loadSteersDir(missing).systemPrompt).toContain("whether a steer");

    const empty = makeSteersDir({ "SYSTEM.md": "  \n" });
    const emptyConfig = loadSteersDir(empty);
    expect(emptyConfig.systemPrompt).toContain("whether a steer");
    expect(emptyConfig.diagnostics[0]).toContain("must not be empty");
  });

  it("isolates an invalid steer without disabling valid steers", () => {
    const dir = makeSteersDir({
      "valid/STEER.md":
        "---\nname: valid\ndescription: Valid policy.\ntrigger: run_end\nmode: blocking\n---\nPolicy.",
      "invalid/STEER.md": "not frontmatter",
    });

    const config = loadSteersDir(dir);
    expect(config.steers.map((steer) => steer.name)).toEqual(["valid"]);
    expect(config.diagnostics).toHaveLength(1);
    expect(config.diagnostics[0]).toContain("invalid");
  });

  it("loads the repository examples", () => {
    const exampleDir = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "examples",
    );
    const config = loadSteersDir(exampleDir);

    expect(config.steers.map((steer) => steer.name)).toEqual([
      "defensive-code",
      "ste-docs",
    ]);
    for (const steer of config.steers) {
      expect(steer.policy).toContain("## Resolved when");
    }
  });

  it("resolves portable and Pi-specific directories in precedence order", () => {
    const cwd = path.join("C:", "repo");
    const homeDir = path.join("C:", "home");
    const expected = [
      path.join(cwd, ".agents", "steers"),
      path.join(cwd, ".pi", "steers"),
      path.join(homeDir, ".agents", "steers"),
      path.join(homeDir, ".pi", "steers"),
    ];

    expect(resolveSteersDirs(cwd, homeDir, () => true)).toEqual(expected);
    expect(resolveSteersDirs(cwd, homeDir, () => false)).toEqual([]);
  });

  it("lets higher-precedence directories shadow lower-precedence steers", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "steers-project-"));
    const homeDir = mkdtempSync(path.join(tmpdir(), "steers-home-"));
    const project = path.join(cwd, ".agents", "steers", "same");
    const user = path.join(homeDir, ".agents", "steers", "same");
    mkdirSync(project, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(
      path.join(project, "STEER.md"),
      "---\nname: same\ndescription: Project policy.\ntrigger: run_end\nmode: blocking\n---\nProject body.",
    );
    writeFileSync(
      path.join(user, "STEER.md"),
      "---\nname: same\ndescription: User policy.\ntrigger: turn_end\nmode: async\n---\nUser body.",
    );

    const config = loadSteersConfig(cwd, homeDir);
    expect(config.steers).toHaveLength(1);
    expect(config.steers[0]?.description).toBe("Project policy.");
  });
});

describe("verdict schema injection", () => {
  it("requests strict JSON schema on OpenAI completion payloads", () => {
    const injected = injectVerdictSchema({ model: "gpt" }, "openai-completions");
    expect(injected).toEqual({
      model: "gpt",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "verdict",
          strict: true,
          schema: expect.objectContaining({ type: "object" }),
        },
      },
    });
  });

  it("requests JSON schema on OpenAI responses payloads, preserving text settings", () => {
    const injected = injectVerdictSchema(
      { text: { verbosity: "low" } },
      "openai-codex-responses",
    ) as Record<string, Record<string, unknown>>;
    expect(injected.text.verbosity).toBe("low");
    expect(injected.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
  });

  it("requests a JSON response schema on Google payloads", () => {
    const injected = injectVerdictSchema(
      { config: { temperature: 0 } },
      "google-generative-ai",
    ) as Record<string, Record<string, unknown>>;
    expect(injected.config.temperature).toBe(0);
    expect(injected.config.responseMimeType).toBe("application/json");
    expect(injected.config.responseSchema).toMatchObject({ type: "OBJECT" });
  });

  it("forces a verdict tool call on Anthropic payloads", () => {
    const injected = injectVerdictSchema(
      { tools: [{ name: "other" }] },
      "anthropic-messages",
    ) as Record<string, unknown>;
    expect(injected.tools).toHaveLength(2);
    expect(injected.tool_choice).toEqual({
      type: "tool",
      name: "steering_verdict",
    });
  });

  it("leaves unknown APIs and non-object payloads unchanged", () => {
    const payload = { model: "x" };
    expect(injectVerdictSchema(payload, "mistral-conversations")).toEqual(
      payload,
    );
    expect(injectVerdictSchema("nope", "openai-completions")).toBe("nope");
  });
});

describe("verdict extraction", () => {
  it("reads the forced tool call arguments when present", () => {
    const content = [
      { type: "text", text: "reasoning out loud" },
      {
        type: "toolCall",
        id: "1",
        name: "steering_verdict",
        arguments: { shouldSteer: true, message: "Fix it." },
      },
    ];
    const result = verdictFromResponse(content as never);
    expect(result.raw).toContain("Fix it.");
    expect(result.verdict).toEqual({ shouldSteer: true, message: "Fix it." });
  });

  it("falls back to parsing text content", () => {
    const content = [
      { type: "text", text: '{"shouldSteer":false,"message":null}' },
    ];
    expect(verdictFromResponse(content as never).verdict).toEqual({
      shouldSteer: false,
      message: null,
    });
  });
});

describe("verdict parsing", () => {
  it("parses strict JSON verdicts", () => {
    expect(parseVerdict('{"shouldSteer":false,"message":null}')).toEqual({
      shouldSteer: false,
      message: null,
    });
    expect(
      parseVerdict(
        '{"shouldSteer":true,"message":"Run the tests before claiming they pass."}',
      ),
    ).toEqual({
      shouldSteer: true,
      message: "Run the tests before claiming they pass.",
    });
  });

  it("rejects fenced, embedded, and malformed verdicts", () => {
    expect(
      parseVerdict(
        '```json\n{"shouldSteer":true,"message":"Check the failing path first."}\n```',
      ),
    ).toBeNull();
    expect(
      parseVerdict(
        'Verdict: {"shouldSteer":true,"message":"Check the failing path first."}',
      ),
    ).toBeNull();
    expect(parseVerdict('{"shouldSteer":true,"message":null}')).toBeNull();
    expect(
      parseVerdict('{"shouldSteer":false,"message":"Do something."}'),
    ).toBeNull();
    expect(
      parseVerdict(
        '{"shouldSteer":false,"message":null,"reason":"extra output"}',
      ),
    ).toBeNull();
    expect(parseVerdict("not json")).toBeNull();
  });
});

describe("evaluator request framing", () => {
  it("appends the policy to the replacement system message", () => {
    const steer = parseSteerMarkdown(
      "---\nname: verify\ndescription: Verify claims.\ntrigger: run_end\nmode: blocking\n---\nRequire direct evidence.",
      "verify",
    );
    const request = buildSteerEvaluationRequest(
      steer,
      "Replacement evaluator system message.",
      "user:\nShip it.",
    );

    expect(request).toEqual({
      system:
        "Replacement evaluator system message.\n\nSteer policy:\nRequire direct evidence.",
      user: "user:\nShip it.",
    });
  });

  it("renders only conversation and tool activity without lifecycle data", () => {
    const rendered = renderEvaluationMessages([
      { role: "system", content: "Original agent system message." },
      { role: "user", content: "Run the tests." },
      {
        role: "assistant",
        stopReason: "toolUse",
        turnIndex: 4,
        content: [
          { type: "text", text: "I will run them." },
          {
            type: "toolCall",
            name: "bash",
            id: "tool-1",
            arguments: { command: "npm test" },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: "26 tests passed.",
      },
      { role: "custom", customType: "turn_end", content: "event data" },
    ]);

    expect(rendered).toContain("user:\nRun the tests.");
    expect(rendered).toContain("assistant:\nI will run them.");
    expect(rendered).toContain("toolResult tool=bash isError=false");
    expect(rendered).not.toContain("Original agent system message");
    expect(rendered).not.toContain("stopReason");
    expect(rendered).not.toContain("turnIndex");
    expect(rendered).not.toContain("event data");
  });
});

describe("log record shape", () => {
  it("creates the Steers JSONL schema fields", () => {
    const record = createLogRecord({
      ts: "2026-07-04T03:00:00.000Z",
      sessionId: "session-123",
      steer: "unproven-claim",
      trigger: "turn_end",
      mode: "async",
      model: "openai/gpt-5-codex",
      request: {
        system: "system",
        user: "user",
      },
      raw: '{"shouldSteer":true,"message":"Verify first."}',
      verdict: { shouldSteer: true, message: "Verify first." },
      steered: true,
      deliverAs: "steer",
      failure: null,
      waitMs: null,
    });

    expect(Object.keys(record)).toEqual([
      "ts",
      "sessionId",
      "steer",
      "trigger",
      "mode",
      "model",
      "request",
      "response",
      "delivery",
    ]);
    expect(Object.keys(record.request)).toEqual(["system", "user"]);
    expect(Object.keys(record.response)).toEqual(["raw", "verdict"]);
    expect(Object.keys(record.delivery)).toEqual([
      "steered",
      "deliverAs",
      "failure",
      "waitMs",
    ]);
    expect(roundTrip(record)).toEqual(record);
  });

  it("represents invalid verdicts with an actionable failure name", () => {
    const record = createLogRecord({
      sessionId: "session-123",
      steer: "premature-stop",
      trigger: "run_end",
      mode: "blocking",
      model: "anthropic/claude-opus-4-5",
      request: {
        system: "system",
        user: "user",
      },
      raw: "not json",
      verdict: null,
      steered: false,
      deliverAs: null,
      failure: "invalid-verdict",
      waitMs: 812,
    });

    expect(record.response.verdict).toBeNull();
    expect(record.delivery).toMatchObject({
      steered: false,
      deliverAs: null,
      failure: "invalid-verdict",
      waitMs: 812,
    });
  });
});

describe("stale-ctx safety", () => {
  // An async steer can finish after the session teardown. Then, each read of a
  // ctx property throws an error. A failed notification must not crash the run.
  it("swallows errors from a stale ctx instead of throwing", () => {
    const staleCtx = new Proxy(
      {},
      {
        get() {
          throw new Error(
            "This extension ctx is stale after session replacement or reload",
          );
        },
      },
    );

    expect(() =>
      safeNotify(staleCtx as never, "async steer failed", "warning"),
    ).not.toThrow();
  });
});

function makeSteersDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "steers-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(dir, ...relativePath.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
  return dir;
}

function roundTrip(record: LogRecord): LogRecord {
  return JSON.parse(JSON.stringify(record)) as LogRecord;
}
