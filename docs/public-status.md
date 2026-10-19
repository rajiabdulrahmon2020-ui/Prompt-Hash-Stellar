# Public Status Model (#986)

`GET /api/status` tells users and operators whether the marketplace is
working. Before this change, the endpoint could not load: it imported a
maintenance module that did not exist, and the maintenance model had a syntax
error. It also published raw error text and probe details, and it never
reported a paused contract or an active maintenance window.

## States

`derivePublicStatus` (`server/src/services/publicStatus.ts`) picks exactly one
state. The first match wins:

| State | When | What users should expect |
|---|---|---|
| `outage` | No dependency check is up | Nothing works. |
| `paused` | The contract's `is_paused` view returns `true` | Purchases, listings, and other contract writes fail on-chain with `ContractIsPaused`. Unlocking already-purchased prompts still works. |
| `maintenance` | A maintenance banner window is open (any scope) | Planned work. The windows are listed in `maintenance`. |
| `degraded` | At least one check is not up | Some features may be slow or failing. |
| `operational` | Everything is up | Normal. |

The pause flag is read with a free, read-only `simulateTransaction` call
through `readContract`. An unreadable flag (`paused: null`) never produces
`paused`: the failing contract read already shows up as a degraded component.

## Response

The response keeps every field existing clients read and adds `state` and
`paused`:

```json
{
  "state": "paused",
  "status": "degraded",
  "paused": true,
  "services": [{ "name": "Unlock Service", "status": "down", "latencyMs": null, "error": "unreachable" }],
  "probes": [{ "name": "contract_read", "status": "healthy", "latencyMs": 210, "timestamp": "…" }],
  "maintenance": [{ "id": "…", "title": "…", "message": "…", "severity": "warning", "scopes": ["wallet"], "affectedFeatures": [], "startsAt": "…", "endsAt": "…" }],
  "timestamp": "…",
  "uptime": 1234,
  "indexer": { "lastIndexedLedger": 123, "status": "active" }
}
```

- **`status`** keeps its legacy three values: `outage` maps to `down`,
  `operational` maps to `up`, and every other state maps to `degraded`.
- **`services[].error`** is now a fixed reason code: `timeout`,
  `unreachable`, `http_error`, `unhealthy` or `check_failed`. Raw messages
  stay in the server logs.
- **`probes[]`** no longer carries `error` or `details`. Details held values
  such as the simulation account and prompt IDs.
- **`maintenance[]`** is the public banner projection. It never includes the
  creator, editor, or enabled flag.

The status page (`src/pages/status/page.tsx`) shows the state headline, lists
active maintenance windows, and falls back to `status` when an older
deployment does not send `state`.

## State changes over time

Nobody has to clear a state by hand:

- A maintenance window opens and closes on its own: `listActive(now)` returns
  only banners with `startsAt <= now < endsAt`.
- Unpausing the contract (`set_pause_status(false)`) clears `paused` on the
  next request.
- The page re-polls every 30 seconds.

## Failure modes

| Failure | Effect |
|---|---|
| Pause read fails, times out (8 s), or is not configured | `paused: null`; the state is derived from the other inputs |
| Banner store (MongoDB) read fails | `maintenance: []`; logged server-side |
| `connectDb` or the indexer lookup fails | Generic `500 {"status":"down","error":"Failed to run status checks"}` (unchanged behaviour) |

## Operator runbook

- **Announce maintenance:** create a banner through the existing admin
  routes (`/api/maintenance`). It appears on the status page while its window
  is open, across all scopes.
- **Pause the marketplace:** the contract owner calls `set_pause_status(true)`.
  The status page shows `paused` within one poll. Unpause with
  `set_pause_status(false)`.
- **Status shows `paused` unexpectedly:** confirm with
  `stellar contract invoke --id <contract> --source-account <account> --network <network> --send=no -- is_paused`
  (simulation only; nothing is submitted).
  The status page reports what the ledger says.

## Rollback

Revert `api/status.ts`, `src/pages/status/page.tsx`, and
`server/src/services/publicStatus.ts`. The additive fields disappear and older
clients are unaffected. Keep the maintenance model and service fixes: without
them the status endpoint fails to load again. There is no data migration.
