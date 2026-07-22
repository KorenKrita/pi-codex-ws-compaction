import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const testHome = mkdtempSync(join(tmpdir(), "pi-codex-ws-compaction-smoke-"));
process.env.HOME = testHome;
process.env.CODEX_HOME = join(testHome, ".codex");

const configDir = join(testHome, ".pi", "agent");
mkdirSync(configDir, { recursive: true });
writeFileSync(
  join(configDir, "pi-codex-ws-compaction.json"),
  JSON.stringify({
    enabled: true,
    provider: "local-responses",
    models: ["gpt-5.6-sol", "gpt-5.4-mini"],
    notify: false,
  }),
);

try {
  const configModule = await import(pathToFileURL(join(repoRoot, "src", "config.ts")).href);
  const openaiModule = await import(pathToFileURL(join(repoRoot, "src", "openai.ts")).href);
  const remoteModule = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
  const wsModule = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);
  const { default: extensionFactory } = await import(
    pathToFileURL(join(repoRoot, "src", "index.ts")).href
  );

  const config = configModule.loadConfig();
  assert.equal(config.provider, "local-responses");
  assert.deepEqual(config.models, ["gpt-5.6-sol", "gpt-5.4-mini"]);
  assert.equal(
    configModule.resolveWebSocketUrl("https://llm.example.com/v1"),
    "wss://llm.example.com/v1/responses",
  );
  assert.equal(
    configModule.resolveWebSocketUrl("https://llm.example.com"),
    "wss://llm.example.com/v1/responses",
  );
  assert.equal(
    configModule.resolveHttpResponsesUrl("https://llm.example.com"),
    "https://llm.example.com/v1/responses",
  );
  assert.equal(
    configModule.resolveWebSocketUrl("http://127.0.0.1:8080/api"),
    "ws://127.0.0.1:8080/api/responses",
  );
  assert.equal(
    configModule.resolveWebSocketUrl(
      "https://ignored.example/v1",
      "wss://override.example/custom/responses",
    ),
    "wss://override.example/custom/responses",
  );

  const targetModel = {
    provider: "local-responses",
    api: "openai-responses",
    id: "gpt-5.6-sol",
    baseUrl: "https://llm.example.com/v1",
    input: ["text"],
  };
  assert.equal(openaiModule.isConfiguredResponsesModel(targetModel, config), true);
  assert.equal(
    openaiModule.isConfiguredResponsesModel({ ...targetModel, provider: "openai" }, config),
    false,
  );
  assert.equal(
    openaiModule.isConfiguredResponsesModel({ ...targetModel, id: "not-allowed" }, config),
    false,
  );

  assert.equal(
    remoteModule.remoteCompactionV2EndpointUrl(targetModel, config),
    "https://llm.example.com/v1/responses",
  );
  const body = remoteModule.buildRemoteCompactionRequestBody({
    model: targetModel,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "marker" }] }],
    instructions: "system",
    tools: [{ type: "function", name: "read" }],
    parallelToolCalls: true,
    reasoning: { effort: "high", summary: "auto" },
    text: { verbosity: "medium" },
    sessionId: "session-123",
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
  assert.equal(body.prompt_cache_key, "session-123");

  const headers = remoteModule.buildRemoteCompactionHeaders({
    model: targetModel,
    apiKey: "test-key",
    sessionId: "session-123",
    config,
    headers: { Authorization: "Bearer gateway-token", "x-gateway": "yes" },
  });
  const authorizationHeaders = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "authorization",
  );
  assert.deepEqual(authorizationHeaders, [["Authorization", "Bearer gateway-token"]]);
  assert.equal(headers["x-codex-beta-features"], "remote_compaction_v2");
  assert.equal(headers["x-gateway"], "yes");

  const parsed = remoteModule.parseRemoteCompactionV2Events([
    {
      type: "response.output_item.done",
      item: { type: "compaction", encrypted_content: "OPAQUE" },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
    },
  ]);
  assert.equal(parsed.compactionItem.type, "compaction");
  const replacementHistory = remoteModule.buildRemoteCompactionV2History(
    [
      { type: "message", role: "user", content: [{ type: "input_text", text: "retain" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "drop" }] },
    ],
    parsed.compactionItem,
  );
  assert.deepEqual(replacementHistory.map((item) => item.type), ["message", "compaction"]);

  const modelKey = "local-responses:openai-responses:gpt-5.6-sol";
  const reconstructed = remoteModule.reconstructRemoteCompactionStateFromBranch({
    branchEntries: [
      {
        type: "compaction",
        id: "cmp-1",
        details: {
          remoteCompaction: remoteModule.buildRemoteCompactionDetails(
            targetModel,
            replacementHistory,
          ),
        },
      },
      {
        type: "message",
        id: "user-2",
        message: { role: "user", content: [{ type: "text", text: "after" }] },
      },
      {
        type: "message",
        id: "assistant-2",
        message: {
          role: "assistant",
          provider: "local-responses",
          api: "openai-responses",
          model: "gpt-5.6-sol",
          content: [{ type: "text", text: "reply" }],
        },
      },
    ],
  });
  assert.ok(reconstructed);
  assert.equal(reconstructed.modelKey, modelKey);
  assert.match(JSON.stringify(reconstructed.explicitHistory), /OPAQUE|after|reply/);

  const incremental = wsModule.selectInputItemsForContinuation({
    context: {
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "assistant", content: [{ type: "text", text: "old reply" }] },
        { role: "user", content: [{ type: "text", text: "new" }] },
      ],
    },
    model: { input: ["text"] },
    session: { lastContextLength: 2 },
    currentModelKey: modelKey,
    remoteCompactionState: reconstructed,
    previousResponseId: "resp-1",
  });
  assert.deepEqual(incremental, [{ type: "message", role: "user", content: "new" }]);

  const firstPostCompactionInput = wsModule.selectInputItemsForContinuation({
    context: { messages: [] },
    model: { input: ["text"] },
    session: { lastContextLength: 0 },
    currentModelKey: modelKey,
    remoteCompactionState: reconstructed,
    previousResponseId: undefined,
  });
  assert.match(JSON.stringify(firstPostCompactionInput), /OPAQUE/);

  const missingKeyStream = wsModule.createOpenAIWebSocketStreamFn({}, config)(
    targetModel,
    { messages: [] },
    { sessionId: "session-without-key" },
  );
  const missingKeyResult = await missingKeyStream.result();
  assert.equal(missingKeyResult.stopReason, "error");
  assert.match(missingKeyResult.errorMessage ?? "", /require an API key/i);

  const registrations = [];
  const handlers = [];
  extensionFactory({
    registerProvider(provider, providerConfig) {
      registrations.push({ provider, providerConfig });
    },
    on(event, handler) {
      handlers.push({ event, handler });
    },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].provider, "local-responses");
  assert.equal(registrations[0].providerConfig.api, "openai-responses");
  assert.equal(typeof registrations[0].providerConfig.streamSimple, "function");
  assert.ok(handlers.some(({ event }) => event === "session_before_compact"));
  assert.ok(handlers.some(({ event }) => event === "session_shutdown"));

  writeFileSync(
    join(configDir, "pi-codex-ws-compaction.json"),
    JSON.stringify({ enabled: false }),
  );
  const disabledRegistrations = [];
  const disabledHandlers = [];
  extensionFactory({
    registerProvider(...args) {
      disabledRegistrations.push(args);
    },
    on(...args) {
      disabledHandlers.push(args);
    },
  });
  assert.deepEqual(disabledRegistrations, []);
  assert.deepEqual(disabledHandlers, []);

  console.log("smoke ok");
} finally {
  rmSync(testHome, { recursive: true, force: true });
}
