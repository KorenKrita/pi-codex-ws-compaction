/**
 * Global configuration for the tailored Codex Responses/WebSocket extension.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type JsonRecord = Record<string, unknown>;

export const CONFIG_FILE_NAME = "pi-codex-ws-compaction.json";
export const CONFIG_PATH = join(homedir(), ".pi", "agent", CONFIG_FILE_NAME);

export const DEFAULT_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

export type ExtensionConfig = {
  enabled?: boolean;
  provider?: string;
  models?: string[];
  websocketUrl?: string;
  notify?: boolean;
};

export type RuntimeConfig = {
  enabled: boolean;
  provider: string;
  models: string[];
  websocketUrl?: string;
  notify: boolean;
};

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid config in ${path}: expected a JSON object.`);
  }
  return parsed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${field} in ${CONFIG_PATH}: expected a boolean.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${field} in ${CONFIG_PATH}: expected a non-empty string.`);
  }
  return value.trim();
}

function optionalModels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid models in ${CONFIG_PATH}: expected a non-empty string array.`);
  }
  const models = value.map((model) => {
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new Error(`Invalid models in ${CONFIG_PATH}: every model must be a non-empty string.`);
    }
    return model.trim();
  });
  return [...new Set(models)];
}

function validateWebSocketUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid websocketUrl in ${CONFIG_PATH}: ${value}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Invalid websocketUrl in ${CONFIG_PATH}: protocol must be ws or wss.`);
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(): RuntimeConfig {
  const raw = readConfigFile(CONFIG_PATH);
  const websocketUrl = validateWebSocketUrl(optionalString(raw.websocketUrl, "websocketUrl"));
  return {
    enabled: optionalBoolean(raw.enabled, "enabled") ?? true,
    provider: optionalString(raw.provider, "provider") ?? "local-responses",
    models: optionalModels(raw.models) ?? [...DEFAULT_MODELS],
    ...(websocketUrl ? { websocketUrl } : {}),
    notify: optionalBoolean(raw.notify, "notify") ?? false,
  };
}

function resolveResponsesUrl(baseUrl: unknown, transport: "http" | "websocket"): string {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new Error(`Cannot derive Responses URL: the selected model has no baseUrl.`);
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Cannot derive Responses URL from model baseUrl: ${String(baseUrl)}`);
  }
  if (transport === "websocket") {
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`Cannot derive WebSocket URL from unsupported protocol: ${url.protocol}`);
    }
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Cannot derive HTTP Responses URL from unsupported protocol: ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/responses") ? path : `${path || "/v1"}/responses`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function resolveHttpResponsesUrl(baseUrl: unknown): string {
  return resolveResponsesUrl(baseUrl, "http");
}

export function resolveWebSocketUrl(baseUrl: unknown, configuredUrl?: string): string {
  if (configuredUrl) return validateWebSocketUrl(configuredUrl)!;
  try {
    return resolveResponsesUrl(baseUrl, "websocket");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Set websocketUrl in ${CONFIG_PATH} to override derivation.`);
  }
}

export function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
