# Architecture

## Scope

This package composes over one provider already declared in Pi's `models.json`. It preserves the provider's models and auth, replacing only `streamSimple` for the configured model allowlist.

```text
models.json provider
      |
      v
src/index.ts registerProvider(provider, streamSimple)
      |
      +--> non-target model: Pi HTTP Responses stream
      |
      +--> target model: custom Responses WebSocket stream
```

## Normal turn

1. `src/custom-stream.ts` checks exact provider/API/model eligibility.
2. `src/openai-ws-stream.ts` derives or reads the WS URL and opens one socket per Pi session.
3. The first request sends full Responses input.
4. Later requests reuse `previous_response_id` only while the socket and request shape remain compatible, sending only new messages.
5. WS events are translated into Pi stream events and final assistant messages.
6. Any socket failure terminates the target turn visibly; it does not silently switch a live session to HTTP continuity.

Calls without a Pi session id are internal summarization calls. They use Pi's normal full-input HTTP Responses stream and never use HTTP `previous_response_id`.

## Compaction boundary

1. `session_before_compact` converts the active Pi branch to Responses input items.
2. It requests a portable text summary and remote compaction in parallel.
3. Remote compaction sends the normal HTTP Responses request with a trailing `compaction_trigger` and the `remote_compaction_v2` feature header.
4. The response must complete and contain exactly one opaque `compaction` item.
5. Pi persists both the readable text summary and `details.remoteCompaction`.
6. Future compatible WS turns replay retained user messages plus the opaque artifact.

## State

Persisted:

- Pi messages and compaction entries
- readable text summary
- opaque remote compaction replacement history

Runtime-only:

- latest WS response id
- context length associated with that response
- reconstructed remote history for the active branch
- one WS connection per active Pi session

Runtime state is cleared on session switches, forks, tree navigation, model changes, compaction completion, and shutdown. Persisted artifacts are reconstructed from the active branch after reload/resume.

## Trust boundaries

- Config is read only from `~/.pi/agent/pi-codex-ws-compaction.json`.
- API keys and effective provider headers are resolved by Pi, not stored in extension config.
- Configured provider/model equality gates every custom transport and compaction action.
- Artifacts are replayed only when provider, API, and model id match the producing model.
- Invalid config fails closed during extension loading.
