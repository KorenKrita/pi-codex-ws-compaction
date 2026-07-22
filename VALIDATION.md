# Validation

## Pre-implementation endpoint evidence

The target gateway was probed against all configured models:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`

Observed behavior:

- Responses compaction v2 returned exactly one opaque `compaction` item for every model.
- Replaying each artifact recovered a hidden marker correctly.
- Legacy `POST /v1/responses/compact` returned HTTP 404.
- HTTP `previous_response_id` returned HTTP 200 but did not preserve context.
- Same-connection WebSocket `previous_response_id` preserved context.
- `context_management` was accepted but its semantics were not demonstrated.

These results define the extension's scope: explicit compaction v2 plus WebSocket continuity, without legacy compaction or HTTP continuation.

## Repository evidence

Validated on 2026-07-22 with Pi `0.81.1` and Node.js `v24.18.0`.

```bash
npm test
```

Passed TypeScript checking and the offline smoke suite, including strict config parsing, URL derivation, target allowlisting, case-insensitive effective authorization-header precedence, compaction v2 event parsing, persisted artifact reconstruction, and incremental WS input selection.

```bash
npm run test:live
```

Passed all live cases against `local-responses/gpt-5.6-sol`:

- normal same-process WebSocket continuation;
- reduced-plaintext opaque artifact replay;
- fork safety after compaction;
- restart/resume after compaction;
- restart/resume after a configured-model switch round trip.

The test inspected Pi session data and confirmed:

```text
details.remoteCompaction.implementation = responses_compaction_v2
details.remoteCompaction.replacementHistory[-1].type = compaction
```

`npm pack --dry-run` also passed and contained only the focused runtime, tests, and documentation.
