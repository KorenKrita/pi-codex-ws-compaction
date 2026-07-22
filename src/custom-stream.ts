/** Provider stream dispatcher for the configured Responses models. */
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/compat";
import type { RuntimeConfig } from "./config.ts";
import { createOpenAIWebSocketStreamFn } from "./openai-ws-stream.ts";
import { isConfiguredResponsesModel } from "./openai.ts";

export function createConfiguredResponsesStream(config: RuntimeConfig): StreamFunction {
  const websocketStream = createOpenAIWebSocketStreamFn({}, config);
  return (model, context, options) => {
    if (!isConfiguredResponsesModel(model, config)) {
      return streamSimpleOpenAIResponses(
        model as Model<"openai-responses">,
        context as Context,
        options as SimpleStreamOptions | undefined,
      );
    }
    return websocketStream(model, context, options);
  };
}
