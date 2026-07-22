/**
 * Extension entrypoint: configured-provider WS transport plus Responses compaction v2.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isRecord, loadConfig } from "./config.ts";
import { createConfiguredResponsesStream } from "./custom-stream.ts";
import {
  extractAssistantResponseId,
  isConfiguredResponsesModel,
  extractResponsesReasoningConfig,
  extractResponsesTextConfig,
  looksLikeResponsesPayload,
  messageMatchesModel,
  modelKey,
  thinkingLevelToResponsesReasoning,
} from "./openai.ts";
import { releaseAllWsSessions, releaseWsSession } from "./openai-ws-stream.ts";
import {
  buildCompactionSummaryText,
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generateBestEffortLocalSummary,
  messageToResponseItems,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
} from "./remote-compaction.ts";
import {
  clearAllContinuationState,
  clearContinuationState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setContinuationState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

type SessionContextLike = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
    buildContextEntries(): SessionEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function getBranchMessages(branchEntries: BranchEntry[]): AgentMessage[] {
  return branchEntries.flatMap((entry) =>
    entry.type === "message" && entry.message ? [entry.message as AgentMessage] : [],
  );
}

function getContextMessageCount(ctx: SessionContextLike): number {
  return ctx.sessionManager
    .buildContextEntries()
    .reduce((count, entry) => count + sessionEntryToContextMessages(entry).length, 0);
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function clearLiveContinuation(sessionId: string | undefined): void {
  clearContinuationState(sessionId);
  releaseWsSession(sessionId);
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearLiveContinuation(sessionId);
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) setRemoteCompactionState(sessionId, state);
  else clearRemoteCompactionState(sessionId);
}

function getMatchingRemoteState(sessionId: string, model: TargetModel | undefined) {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function extendRemoteHistoryIfCompatible(params: {
  sessionId: string;
  model: TargetModel | undefined;
  message: AgentMessage;
}): void {
  const remoteState = getMatchingRemoteState(params.sessionId, params.model);
  if (!remoteState || !params.model) return;
  if (params.message.role === "assistant" && !messageMatchesModel(params.message, params.model)) return;
  const items = messageToResponseItems(params.message);
  if (items.length === 0) return;
  setRemoteCompactionState(params.sessionId, {
    ...remoteState,
    explicitHistory: [...remoteState.explicitHistory, ...items],
  });
}

export default function codexWsCompactionExtension(pi: ExtensionAPI) {
  const startupConfig = loadConfig();
  if (!startupConfig.enabled) return;
  const notifiedModels = new Set<string>();

  pi.registerProvider(startupConfig.provider, {
    api: "openai-responses",
    streamSimple: createConfiguredResponsesStream(startupConfig),
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearLiveContinuation(sessionId);
    clearResponsesRequestShapeState(sessionId);
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearSessionRuntimeState(getSessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearLiveContinuation(getSessionId(ctx));
    syncRemoteState(ctx);
  };
  pi.on("session_tree", syncAfterSessionChange);
  pi.on("session_compact", syncAfterSessionChange);

  pi.on("model_select", (_event, ctx) => {
    clearLiveContinuation(getSessionId(ctx));
  });

  pi.on("session_shutdown", () => {
    clearAllContinuationState();
    releaseAllWsSessions();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const config = startupConfig;
    const model = ctx.model;
    if (!model || !isConfiguredResponsesModel(model, config)) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;

    const tools = buildToolsPayload(pi.getAllTools(), pi.getActiveTools());
    const sessionId = getSessionId(ctx);
    const branchEntries = event.branchEntries as BranchEntry[];
    const remoteState = getMatchingRemoteState(sessionId, model);
    const observedRequestShape = getResponsesRequestShapeState(sessionId);
    const fullBranchMessages = getBranchMessages(branchEntries);
    const responseItems = remoteState
      ? remoteState.explicitHistory
      : messagesToResponseItems(fullBranchMessages);
    const promptResponseItems = normalizeResponseItemsForPrompt(responseItems, model);
    const thinkingLevel = pi.getThinkingLevel();
    const fallbackReasoning = model.reasoning
      ? thinkingLevelToResponsesReasoning(thinkingLevel ?? getBranchThinkingLevel(branchEntries))
      : undefined;

    const [localResult, remoteResult] = await Promise.allSettled([
      generateBestEffortLocalSummary({
        preparation: event.preparation,
        messages: fullBranchMessages,
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        customInstructions: event.customInstructions,
        signal: event.signal,
        thinkingLevel,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      }),
      callRemoteCompactionEndpoint({
        config,
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        sessionId,
        input: promptResponseItems,
        instructions: ctx.getSystemPrompt(),
        tools,
        parallelToolCalls: true,
        reasoning: observedRequestShape?.reasoning ?? fallbackReasoning,
        text: observedRequestShape?.text,
        signal: event.signal,
      }),
    ]);

    if (remoteResult.status !== "fulfilled") {
      const message =
        remoteResult.reason instanceof Error ? remoteResult.reason.message : String(remoteResult.reason);
      console.warn(`[pi-codex-ws-compaction] Remote compaction failed: ${message}`);
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify(`Remote compaction failed; using portable Pi summary. ${message}`, "warning");
      }
      if (localResult.status === "fulfilled") return { compaction: localResult.value };
      return undefined;
    }

    const remoteDetails = buildRemoteCompactionDetails(
      model,
      remoteResult.value.output,
      remoteResult.value.usage,
    );
    const localSummary =
      localResult.status === "fulfilled"
        ? localResult.value
        : {
            summary: buildCompactionSummaryText(model),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          };

    return {
      compaction: {
        summary: localSummary.summary,
        firstKeptEntryId: localSummary.firstKeptEntryId,
        tokensBefore: localSummary.tokensBefore,
        details: {
          ...(localSummary.details !== undefined
            ? { localSummaryDetails: localSummary.details }
            : {}),
          remoteCompaction: remoteDetails,
        },
      },
    };
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = getSessionId(ctx);
    const model = ctx.model;
    extendRemoteHistoryIfCompatible({ sessionId, model, message: event.message });

    const config = startupConfig;
    if (!isConfiguredResponsesModel(model, config)) return;
    if (!messageMatchesModel(event.message, model)) return;
    const responseId = extractAssistantResponseId(event.message);
    if (!responseId) return;
    setContinuationState(sessionId, {
      responseId,
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      contextLength: getContextMessageCount(ctx),
    });
  });

  pi.on("before_provider_request", (event, ctx) => {
    const config = startupConfig;
    const model = ctx.model;
    if (!model || !isConfiguredResponsesModel(model, config)) return undefined;
    if (!isRecord(event.payload) || !looksLikeResponsesPayload(event.payload)) return undefined;

    setResponsesRequestShapeState(getSessionId(ctx), {
      updatedAt: Date.now(),
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractResponsesTextConfig(event.payload),
    });

    if (config.notify && ctx.hasUI) {
      const key = `${String(model.provider)}/${String(model.id)}`;
      if (!notifiedModels.has(key)) {
        notifiedModels.add(key);
        ctx.ui.notify(`Codex WS compaction active for ${key}`, "info");
      }
    }
    return undefined;
  });
}
