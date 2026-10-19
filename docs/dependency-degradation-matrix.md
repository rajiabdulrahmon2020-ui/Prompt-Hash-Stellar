# External Dependency Degradation Matrix

> **Issue**: #980  
> **Purpose**: Documents every critical third-party dependency's failure modes, user-safe fallback
> behavior, and automated health-check probes.

---

## Overview

When a critical dependency degrades or fails entirely, the system transitions into a documented
fallback state rather than failing unpredictably. This matrix enumerates:

- The **failure mode** (what breaks and how).
- The **user-safe API/UX response** (what the operator should configure/expect the system to do).
- The **user-facing message** (safe to surface in HTTP responses and UI toasts — no internal detail).
- **Recovery steps** an operator follows to restore the service.
- An **automated probe** that can be run to detect the failure mode in CI, health dashboards, or
  scheduled smoke tests.

---

## Dependencies

### 1. Stellar RPC (Soroban)

**Purpose**: Soroban RPC node used to simulate transactions, query on-chain state (`has_access`,
prompt data), and submit `buy_prompt` calls.

| Failure Mode | Severity | Fallback Behavior | User Message |
|---|---|---|---|
| `timeout` | HIGH | Unlock and purchase endpoints return HTTP 503 with `Retry-After` header. No funds moved. | "The Stellar network is taking longer than expected. Your funds are safe — please try again." |
| `connection_refused` | CRITICAL | All on-chain operations blocked. Read-only browsing stays available. | "Prompt purchases are temporarily unavailable. You can still browse." |
| `stale_data` | HIGH | `has_access` deferred to secondary node; stale-ledger overlay shown. | "Your access is being verified against a slightly delayed ledger. This is temporary." |

**Recovery**:
1. Check `https://status.stellar.org`.
2. Rotate `STELLAR_RPC_URL` to a backup node.
3. Re-run: `yarn diagnose stellar-rpc` after fix.

**Probe**: `POST <STELLAR_RPC_URL>` with `{"jsonrpc":"2.0","id":1,"method":"getHealth"}` — healthy
when `result.status === "healthy"`.

---

### 2. Stellar Horizon

**Purpose**: REST API for XLM account balance lookups and transaction polling.

| Failure Mode | Severity | Fallback Behavior | User Message |
|---|---|---|---|
| `timeout` | MEDIUM | Balance pre-check skipped with UI warning; transaction proceeds. | "Balance verification is temporarily unavailable. Your transaction may be rejected if balance is insufficient." |
| `rate_limited` | MEDIUM | Exponential back-off with jitter; requests queued for retry. | "We're experiencing high traffic. Please wait a moment before trying again." |

**Recovery**:
1. Check `https://status.stellar.org`.
2. Switch `STELLAR_HORIZON_URL` to Stellar Foundation fallback.

---

### 3. MongoDB

**Purpose**: Primary database — prompts, purchases, entitlements, audit logs, support cases.

| Failure Mode | Severity | Fallback Behavior | User Message |
|---|---|---|---|
| `connection_refused` | CRITICAL | All write/read API endpoints return 503. CDN-cached static content may remain. | "The marketplace is temporarily unavailable for new transactions." |
| `partial_data` | HIGH | Reads retried against primary; writes queued with idempotency keys. | "Some data may appear outdated while our database synchronises. Actions you've taken are safe." |

**Recovery**:
1. Verify `MONGODB_URI` and VPC connectivity.
2. Check Atlas / replica-set primary status.
3. Restore from backup if needed: `yarn db:restore`.
4. Validate state: `yarn data:integrity:monitor`.

---

### 4. Redis

**Purpose**: Distributed rate-limit counters, idempotency keys, challenge nonces, session caches.

| Failure Mode | Severity | Fallback Behavior | User Message |
|---|---|---|---|
| `connection_refused` | HIGH | In-process rate limiter with conservative limits; nonces stored in-process with shorter TTL. | "Some actions may be temporarily limited while we restore our caching service." |
| `stale_data` | LOW | Cache-miss path fetches from MongoDB; stale nonces rejected, fresh challenge required. | "Please re-initiate the signing process to get a fresh verification token." |

**Recovery**:
1. Check `REDIS_HOST` / `REDIS_PORT` env vars.
2. Verify Redis container/cluster health.
3. In-process fallback is automatic for short outages.

---

### 5. IPFS / Pinata

**Purpose**: Off-chain storage for large encrypted prompt payloads.

| Failure Mode | Severity | Fallback Behavior | User Message |
|---|---|---|---|
| `unavailable` | HIGH | `publish_prompt` / `upload_content` blocked. Existing purchased prompts unaffected. | "Prompt storage is temporarily unavailable. Your existing purchases are unaffected — only new publications are paused." |
| `timeout` | MEDIUM | Up to 3 retries with exponential back-off; MongoDB preview served in place of full payload. | "Loading your prompt content is taking longer than usual. We're retrying automatically." |

**Recovery**:
1. Check `https://status.pinata.cloud`.
2. Switch `IPFS_GATEWAY_URL` to alternative gateway.
3. Retry failed uploads: `yarn jobs:run ipfs-upload-retry`.

---

### 6. Content Safety Scanner

**Purpose**: Automated content-safety pipeline that scans prompt submissions.

| Failure Mode | Severity | Fallback Behavior | User Message |
|---|---|---|---|
| `unavailable` | HIGH | Instant auto-publication blocked; submissions routed to manual-review queue. | "Automated content review is temporarily offline. Your submission has been queued for manual review." |
| `timeout` | MEDIUM | Async analysis queue; creator notified when decision is ready. | "Content review is taking a little longer than usual. We'll notify you when it's complete." |

**Recovery**:
1. Check `SAFETY_SCANNER_HEALTH_URL`.
2. Drain manual queue: `yarn jobs:run manual-review-drain`.
3. Re-scan once recovered: `yarn jobs:run safety-rescan`.

---

## Automated Probes

All probes are implemented in `server/src/services/dependencyDegradationMatrix.ts` and can be
executed programmatically:

```typescript
import { runDegradationMatrixProbes } from "./dependencyDegradationMatrix";

const report = await runDegradationMatrixProbes();
// report.overallHealthy — boolean
// report.degradedDependencies — DependencyName[]
// report.results — ProbeResult[]
```

Tests covering probe logic and matrix structural completeness are in
`server/src/tests/dependencyDegradationMatrix.test.ts`.

---

## Operational Edge Cases

| Scenario | Recommended Response |
|---|---|
| Stellar RPC and Horizon both down simultaneously | Block all financial operations; keep browsing available; page on-call immediately (P1). |
| MongoDB primary fails over mid-request | Idempotency keys prevent double-charging; client should retry after 503. |
| Redis flushes during peak traffic | In-process limiter activates; monitor for abuse since limits are local per-instance. |
| IPFS + safety scanner both down | Publication completely blocked; show estimated recovery ETA on creator dashboard. |
| All probes pass but purchases fail | Check on-chain indexer lag (`reconciliationDrift.indexerLagLedgers` in health report). |

---

## Rollback / Recovery Sequence

1. Run `runDegradationMatrixProbes()` to confirm which dependencies are healthy.
2. For each `degradedDependency`, apply the recovery steps listed above.
3. Re-run probes until `overallHealthy === true`.
4. Run the incident drill: `yarn test:incident-drill` to confirm all verification checks pass.
5. Clear any queued fallback jobs and resume normal operations.
