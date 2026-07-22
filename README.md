# pi-codex-ws-compaction

A focused [Pi](https://github.com/earendil-works/pi-mono) extension for custom OpenAI Responses-compatible providers that support:

1. Codex-style remote compaction v2 (`compaction_trigger` + opaque `compaction` artifact).
2. Responses WebSocket streaming with same-connection `previous_response_id` continuity.

This repository is intentionally narrower than the upstream project it was derived from. It does **not** support the legacy `/responses/compact` endpoint, Azure, ChatGPT OAuth/Codex providers, or HTTP `previous_response_id`.

## Requirements

- Pi `>=0.81.1 <0.82.0`
- Node.js `>=22`
- A provider already configured in `~/.pi/agent/models.json` with `api: "openai-responses"`
- A Responses endpoint that supports both compaction v2 over HTTP and normal turns over WebSocket

## Install

```bash
pi install git:github.com/KorenKrita/pi-codex-ws-compaction
```

Create `~/.pi/agent/pi-codex-ws-compaction.json`:

```json
{
  "enabled": true,
  "provider": "local-responses",
  "models": [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini"
  ],
  "notify": false
}
```

The WebSocket URL is derived from the selected model's `baseUrl`:

```text
https://llm.example.com/v1 -> wss://llm.example.com/v1/responses
```

Override it when the gateway uses another route:

```json
{
  "websocketUrl": "wss://llm.example.com/custom/responses"
}
```

Run `/reload` after changing the provider or installation. The config is global-only by design; project-local config is not read.

## Configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Enables the extension. |
| `provider` | string | `local-responses` | Exact Pi provider id to override. |
| `models` | string[] | six GPT models shown above | Exact model allowlist. |
| `websocketUrl` | string | derived from model `baseUrl` | Explicit `ws://` or `wss://` endpoint. |
| `notify` | boolean | `false` | Show a one-time TUI notice when active. |

Invalid config fails extension loading with an actionable error instead of silently falling back.

## Behavior

### Normal turns

Configured models use the Responses WebSocket transport. A WebSocket failure is surfaced as an error; the extension does not silently fall back to HTTP, because HTTP `previous_response_id` continuity is not assumed to work.

Pi-internal summarization calls have no session id and therefore use full-input HTTP Responses requests. They never use HTTP `previous_response_id`.

### Compaction

On Pi compaction, the extension runs two operations in parallel:

- a portable Pi text summary;
- `POST <baseUrl>/responses` with `x-codex-beta-features: remote_compaction_v2` and a trailing `{ "type": "compaction_trigger" }`.

The returned opaque artifact and recent user messages are saved in the Pi compaction entry. On resume, reload, or tree navigation, compatible configured models reconstruct that history and continue over WebSocket.

If remote compaction fails but the portable summary succeeds, Pi keeps the portable summary. If both fail, Pi's default compaction path remains available.

## Safety and data handling

- Normal WS requests send `store: false`.
- Compaction requests send `store: false`.
- Conversation context is sent to the configured provider and gateway.
- Opaque compaction artifacts are persisted in Pi's local session JSONL.
- Artifacts are replayed only when provider, API, and model id match.
- WS continuation state is cleared on session/model/tree lifecycle boundaries.
- No API key is read from this extension's config; Pi resolves provider auth normally.

## Troubleshooting

1. Disable quickly with `{ "enabled": false }` in the config file.
2. Run `/reload` after config changes.
3. Verify the provider uses `api: "openai-responses"`.
4. Set `websocketUrl` explicitly if URL derivation does not match the gateway.
5. Remove with `pi remove pi-codex-ws-compaction`.

## Development

```bash
npm install
npm test
npm run test:live
```

`npm test` is offline. `npm run test:live` uses the current Pi configuration and incurs model calls.

## Attribution

Derived from [`algal/pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction), originally authored by Alexis Gallagher. See `LICENSE.md`.
