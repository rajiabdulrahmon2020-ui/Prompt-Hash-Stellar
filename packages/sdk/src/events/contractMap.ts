/**
 * Cross-service contract map — Issue #984 (scoped slice).
 *
 * Single checked-in registry binding every contract event in
 * `EVENT_SCHEMAS` (packages/sdk/src/events/schema.ts) to its domain,
 * producer, consumers, version rule, and allowed failure behavior.
 *
 * Required fields are derived from `EVENT_SCHEMAS` at import time so this
 * map cannot drift from the canonical schema — adding an event to
 * `schema.ts` without a map entry fails `contractMap.test.ts`.
 *
 * Full producer/consumer tables, version policy, and rollback/recovery
 * steps: docs/cross-service-contract-map.md
 */
import { EVENT_SCHEMAS } from "./schema.js";

export type ContractDomain =
  | "marketplace"
  | "hash-proofs"
  | "entitlements"
  | "settlement";

export type FailureBehavior =
  | "quarantine-and-continue"
  | "retry-with-backoff"
  | "fail-closed"
  | "dead-letter-and-alert";

export interface ContractMapEntry {
  /** Event/topic name, matching `#[contractevent]` in contracts/prompt-hash/src/events.rs. */
  event: string;
  domain: ContractDomain;
  /** On-chain producer (contract entrypoint that emits the event). */
  producer: string;
  /** Off-chain consumers in processing order. */
  consumers: string[];
  /** Required fields — always equal to EVENT_SCHEMAS[event].fields names. */
  requiredFields: string[];
  /** Supported versions (mirrors server/src/services/eventVersions.ts where registered). */
  supportedVersions: number[];
  /** Allowed failure behavior on decode/process failure. */
  onFailure: FailureBehavior;
  /** At-least-once delivery; consumers must be idempotent (ProcessedEvent / dedupeKey). */
  delivery: "at-least-once";
}

function entry(
  event: string,
  domain: ContractDomain,
  producer: string,
  consumers: string[],
  supportedVersions: number[],
  onFailure: FailureBehavior,
): ContractMapEntry {
  const schema = EVENT_SCHEMAS[event];
  if (!schema) throw new Error(`contractMap: no EVENT_SCHEMAS entry for "${event}"`);
  return {
    event,
    domain,
    producer,
    consumers,
    requiredFields: schema.fields.map((f) => f.name),
    supportedVersions,
    onFailure,
    delivery: "at-least-once",
  };
}

const INDEXER = "server/src/services/indexer.ts";
const OUTBOX = "server/src/services/webhookOutbox.ts";
const UNLOCK = "api/prompts/unlock.ts";

/** One entry per EVENT_SCHEMAS key. Keep in sync — contractMap.test.ts enforces it. */
export const CONTRACT_MAP: Record<string, ContractMapEntry> = {
  PromptCreated: entry("PromptCreated", "marketplace", "create_prompt", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  PromptSaleStatusUpdated: entry("PromptSaleStatusUpdated", "marketplace", "set_prompt_sale_status", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  PromptAdminModerated: entry("PromptAdminModerated", "marketplace", "moderate_prompt", [INDEXER, OUTBOX], [1, 2], "quarantine-and-continue"),
  PromptPriceUpdated: entry("PromptPriceUpdated", "marketplace", "update_prompt_price", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  PromptUpdated: entry("PromptUpdated", "marketplace", "update_prompt", [INDEXER], [1], "quarantine-and-continue"),
  PromptPurchased: entry("PromptPurchased", "entitlements", "buy_prompt", [INDEXER, UNLOCK, OUTBOX], [1], "retry-with-backoff"),
  LicenseTransferred: entry("LicenseTransferred", "entitlements", "transfer_license", [INDEXER, UNLOCK, OUTBOX], [1], "retry-with-backoff"),
  PromptTipped: entry("PromptTipped", "settlement", "tip_prompt", [INDEXER, OUTBOX], [1], "retry-with-backoff"),
  VoucherAdded: entry("VoucherAdded", "marketplace", "add_voucher", [INDEXER], [1], "quarantine-and-continue"),
  VoucherRemoved: entry("VoucherRemoved", "marketplace", "remove_voucher", [INDEXER], [1], "quarantine-and-continue"),
  ContractPausedStateChanged: entry("ContractPausedStateChanged", "marketplace", "set_paused", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  FeeUpdated: entry("FeeUpdated", "settlement", "set_fee_percentage", [INDEXER], [1], "quarantine-and-continue"),
  FeeWalletUpdated: entry("FeeWalletUpdated", "settlement", "set_fee_wallet", [INDEXER], [1], "quarantine-and-continue"),
  PlatformFeeUpdated: entry("PlatformFeeUpdated", "settlement", "set_fee_percentage|update_platform_fee", [INDEXER], [1], "quarantine-and-continue"),
  ListingExtended: entry("ListingExtended", "marketplace", "extend_listing", [INDEXER], [1], "quarantine-and-continue"),
  ListingRevised: entry("ListingRevised", "marketplace", "revise_listing", [INDEXER], [1], "quarantine-and-continue"),
  SolvencyViolationDetected: entry("SolvencyViolationDetected", "settlement", "check_asset_solvency", [INDEXER, OUTBOX], [1], "dead-letter-and-alert"),
  SplitsUpdated: entry("SplitsUpdated", "marketplace", "update_splits", [INDEXER], [1], "quarantine-and-continue"),
  DisputeOpened: entry("DisputeOpened", "marketplace", "open_dispute", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  DisputeResolved: entry("DisputeResolved", "marketplace", "resolve_dispute", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  BundleCreated: entry("BundleCreated", "entitlements", "create_bundle", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  BundlePurchased: entry("BundlePurchased", "entitlements", "buy_bundle", [INDEXER, UNLOCK, OUTBOX], [1], "retry-with-backoff"),
  AccessPassCreated: entry("AccessPassCreated", "entitlements", "create_access_pass", [INDEXER, OUTBOX], [1], "quarantine-and-continue"),
  AccessPassPurchased: entry("AccessPassPurchased", "entitlements", "buy_access_pass", [INDEXER, UNLOCK, OUTBOX], [1], "retry-with-backoff"),
  ContractUpgraded: entry("ContractUpgraded", "marketplace", "upgrade", [INDEXER], [1], "dead-letter-and-alert"),
};

/**
 * Integration boundaries with no contract event (hash proofs are verified
 * off-chain against `content_hash`). Documented here so the map covers all
 * four domains from the issue: marketplace, hash proofs, entitlements,
 * Stellar settlement.
 */
export interface IntegrationBoundary {
  domain: ContractDomain;
  producer: string;
  consumer: string;
  requiredFields: string[];
  versionRule: string;
  onFailure: FailureBehavior;
}

export const INTEGRATION_BOUNDARIES: IntegrationBoundary[] = [
  {
    domain: "hash-proofs",
    producer: "src/lib/crypto/promptCrypto.ts (AES-GCM encrypt + SHA-256 content_hash)",
    consumer: "api/prompts/unlock.ts verifyPromptPlaintextHash (contentHashVersion:1, SHA-256)",
    requiredFields: ["ciphertext", "content_hash", "contentHashVersion"],
    versionRule: "contentHashVersion:1 only; new hash algorithm requires new field + discriminator (docs/prompt-integrity-verification.md)",
    onFailure: "fail-closed",
  },
  {
    domain: "entitlements",
    producer: "contract has_access (buy_prompt / transfer_license state)",
    consumer: "api/prompts/unlock.ts verifyEntitlement + server/src/services/entitlementService.ts",
    requiredFields: ["buyer", "prompt_id"],
    versionRule: "contract state is source of truth; off-chain cache (30s TTL) must invalidate on settlement events",
    onFailure: "fail-closed",
  },
  {
    domain: "settlement",
    producer: "contract buy_prompt (SAC transfer buyer -> seller + fee wallet)",
    consumer: "server/src/services/payoutLedgerService.ts + server/src/jobs/handlers/settlementPoll.ts",
    requiredFields: ["buyer", "seller", "price_stroops", "txHash"],
    versionRule: "settlementStatus: settled|pending|failed; zero-drift invariant before auto-resolve",
    onFailure: "retry-with-backoff",
  },
];
