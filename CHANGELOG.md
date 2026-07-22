# Changelog

## 0.1.0 - 2026-07-22

- create a focused derivative for configured custom OpenAI Responses providers
- target Pi `>=0.81.1 <0.82.0`
- add global config at `~/.pi/agent/pi-codex-ws-compaction.json`
- override only the configured provider and exact model allowlist
- derive the WebSocket endpoint from each model's `baseUrl`, with explicit override support
- require WebSocket transport for normal target-model turns and fail visibly instead of silently falling back to HTTP
- keep full-input HTTP only for Pi-internal summarization calls without a session id
- use Responses compaction v2 exclusively; do not call legacy `/responses/compact`
- persist and reconstruct opaque compaction artifacts across Pi session lifecycle events
- preserve portable Pi text summaries as a fallback
- update offline and live verification for the tailored provider path
