# Cross-Service Contract Map — Domain Events & Integration Boundaries

Issue: #984. Canonical registry: `packages/sdk/src/events/contractMap.ts`
(derived from `EVENT_SCHEMAS` in `packages/sdk/src/events/schema.ts`).
Enforced by `packages/sdk/src/events/contractMap.test.ts`.

## Domains

| Domain | Producer | Key events / payload | Consumers (in order) |
|---|---|---|---|
| Marketplace | `contracts/prompt-hash` (`create_prompt`, `update_prompt_price`, `set_prompt_sale_status`, `revise_listing`, `moderate_prompt`, …) | `PromptCreated`, `PromptPriceUpdated`, `PromptSaleStatusUpdated`, `ListingRevised`, `SplitsUpdated`, `VoucherAdded/Removed`, `DisputeOpened/Resolved`, `PromptAdminModerated`, `ContractUpgraded` | `server/src/services/indexer.ts` → Mongo index → `server/src/services/webhookOutbox.ts` fan-out |
| Hash proofs | `src/lib/crypto/promptCrypto.ts` (AES-GCM + `SHA-256` `content_hash`, `contentHashVersion:1`) | No contract event — `ciphertext`, `content_hash`, `contentHashVersion` | `api/prompts/unlock.ts` `verifyPromptPlaintextHash` |
| Creator/buyer entitlements | Contract `buy_prompt` / `transfer_license` / `buy_bundle` / `buy_access_pass` state | `PromptPurchased`, `LicenseTransferred`, `BundlePurchased`, `AccessPassPurchased` + `has_access` reads | `indexer.ts` (invalidate 30s entitlement cache) → `api/prompts/unlock.ts` `verifyEntitlement` → `server/src/services/entitlementService.ts` |
| Stellar settlement | Contract `buy_prompt` SAC transfer (buyer → seller + fee wallet) | `FeeUpdated`, `FeeWalletUpdated`, `PlatformFeeUpdated`, `PromptTipped`, `SolvencyViolationDetected` + `txHash` | `server/src/services/payoutLedgerService.ts` → `server/src/jobs/handlers/settlementPoll.ts` (`settlementStatus: settled\|pending\|failed`) |

Required fields per event are exactly `EVENT_SCHEMAS[event].fields` —
see `contractMap.ts`; they are asserted by test so the map cannot drift.

## Version rules

- Contract events are implicit V1 (no on-wire `version` field); explicit
  `version` is threaded by `decodeEvent` for forward compatibility.
- `PromptAdminModerated` supports `[1, 2]`; all others `[1]`
  (mirrors `server/src/services/eventVersions.ts`).
- Additive changes only (new optional field / new event type). Field removal,
  type change, or semantic change = breaking: consumer must deploy first,
  minimum 7-day grace, 30-day notice (see `docs/event-versioning.md`).
- Hash proofs: `contentHashVersion:1` + `SHA-256` only; a new algorithm needs
  a new field + discriminator (`docs/prompt-integrity-verification.md`).

## Allowed failure behavior

| Situation | Behavior | Mechanism |
|---|---|---|
| Unknown event type / unsupported version | Quarantine and continue (never crash indexer) | `decodeEvent` → `{recognized:false}` → `QuarantinedEvent`, replay via `POST /api/admin/replay-quarantined` |
| Entitlement / settlement processing error | Retry with backoff, idempotent | `ProcessedEvent` dedupe, outbox lease CAS, `MAX_ATTEMPTS=8`, exp backoff + jitter |
| Unlock auth / hash mismatch / stale terms | Fail closed | `401 INVALID_SIGNATURE`, `403 ACCESS_NOT_PURCHASED`, `409 STALE_PROMPT_TERMS`, `500 INTEGRITY_FAILURE` — no plaintext |
| Solvency violation / contract upgrade | Dead-letter and alert | Pause contract, page maintainer, forward-fix or downgrade via `previous WASM_HASH` (`docs/operations/contract-upgrades.md`) |

Delivery is at-least-once everywhere; consumers must be idempotent
(`ProcessedEvent`, webhook `dedupeKey` + `payloadHash`, `Idempotency-Key`).

## Operational edge cases & recovery

- Quarantine spike (>10/min) or new reason → alert, inspect `QuarantinedEvent`, upgrade consumer, replay.
- Stuck settlement (`settlementStatus: pending` > threshold) → `settlementPoll` retries, then `MANUAL_REVIEW` via `operationRecoveryService`.
- Rollback: consumer rollback = revert consumer deploy + replay quarantine;
  contract rollback = downgrade to previous `WASM_HASH`; migration rollback =
  `yarn --cwd server db:rollback`. Never grant/revoke access off-chain.
