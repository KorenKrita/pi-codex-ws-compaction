# Test plan

## Offline gate

Run:

```bash
npm test
```

It must verify:

- TypeScript compatibility with Pi 0.81.x.
- Config parsing and strict validation.
- WebSocket URL derivation and explicit override.
- Exact provider/model allowlisting.
- Responses compaction v2 request shape and event parsing.
- Opaque artifact persistence/reconstruction helpers.
- Incremental input selection when WS `previous_response_id` is available.
- Extension registration against the configured provider.

## Live gate

Run:

```bash
npm run test:live
```

Optional model override:

```bash
PI_CODEX_WS_COMPACTION_TEST_MODEL=local-responses/gpt-5.6-sol npm run test:live
```

The live test must prove:

1. A normal first turn completes through the custom WS stream.
2. A second turn on the same socket recovers a marker via `previous_response_id`.
3. Manual Pi compaction persists `implementation: responses_compaction_v2` and an opaque `compaction` item.
4. The next turn recovers a marker omitted from the portable text summary.
5. Restart/resume reconstructs remote compaction history and still recovers the marker.

## Manual rollback check

1. Set `enabled` to `false` in `~/.pi/agent/pi-codex-ws-compaction.json`.
2. Run `/reload`.
3. Confirm the configured provider returns to Pi's normal HTTP Responses transport.
4. Re-enable and reload.
