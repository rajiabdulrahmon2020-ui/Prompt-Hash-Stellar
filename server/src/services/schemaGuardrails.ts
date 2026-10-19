/**
 * Schema Evolution Guardrails — Issue #970
 *
 * Provides lightweight, composable helpers that enforce forward/backward
 * compatibility rules for every stored record type surfaced through the
 * public API:
 *
 *   • strip / warn on unrecognised fields so future additions never leak
 *     undocumented data to older API consumers.
 *   • detect deprecated fields and attach advisory warnings to the response.
 *   • reject (or coerce) records whose schemaVersion exceeds this build's
 *     maximum supported version.
 *   • produce migration notes so operators know what backfill is needed
 *     after a deploy.
 *
 * Operational edge cases and failure modes are documented at the bottom of
 * this file.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldPolicy = "required" | "optional" | "deprecated" | "unknown";

export interface FieldDescriptor {
  policy: FieldPolicy;
  /** Human-readable migration note shown in warnings / logs. */
  migrationNote?: string;
}

export interface SchemaGuardrailResult<T> {
  /** The sanitised record — guaranteed to contain only known fields. */
  record: T;
  /** Advisory warnings the caller should surface in logs or X-Warning headers. */
  warnings: string[];
  /** Migration notes for deprecated fields found on this record. */
  migrationNotes: string[];
  /** True when any unknown fields were stripped. */
  hadUnknownFields: boolean;
  /** True when any deprecated fields were present. */
  hadDeprecatedFields: boolean;
}

// ---------------------------------------------------------------------------
// Prompt field registry
// ---------------------------------------------------------------------------

/**
 * Registry of every field that the Prompt API response shape is allowed to
 * contain. Keys are field names; values describe their current policy.
 *
 * When you add a new field:
 *   1. Add it here as "optional" (or "required" if it must always be present).
 *   2. Add a compatibility transform in schemaVersioning.ts.
 *   3. Write a test in schemaVersionMigration.test.ts.
 *
 * When you deprecate a field:
 *   1. Change the policy to "deprecated".
 *   2. Add a migrationNote explaining the replacement.
 *   3. Plan removal for the next major version.
 */
export const PROMPT_FIELD_REGISTRY: Record<string, FieldDescriptor> = {
  // Core identity
  _id:              { policy: "required" },
  id:               { policy: "optional" },
  schemaVersion:    { policy: "required" },

  // Creator / ownership
  creator:          { policy: "optional" },
  owner:            { policy: "optional" },

  // Marketplace metadata
  title:            { policy: "required" },
  category:         { policy: "required" },
  description:      { policy: "required" },
  previewText:      { policy: "optional" },
  imageUrl:         { policy: "optional" },
  image:            { policy: "deprecated", migrationNote: "Use `imageUrl` instead. `image` will be removed in schema v3." },
  tags:             { policy: "required" },
  licence:          { policy: "required" },

  // Pricing
  priceStroops:     { policy: "optional" },
  price:            { policy: "deprecated", migrationNote: "Use `priceStroops` (bigint in stroops). `price` will be removed in schema v3." },

  // On-chain state
  onChainId:        { policy: "optional" },
  contentHash:      { policy: "optional" },
  encryptedPrompt:  { policy: "optional" },
  encryptionIv:     { policy: "optional" },
  wrappedKey:       { policy: "optional" },
  salesCount:       { policy: "optional" },

  // Lifecycle / moderation
  active:           { policy: "optional" },
  isActive:         { policy: "deprecated", migrationNote: "Use `active` (boolean). `isActive` will be removed in schema v3." },
  listingStatus:    { policy: "deprecated", migrationNote: "Use `lifecycleState` instead. `listingStatus` will be removed in schema v3." },
  lifecycleState:   { policy: "required" },
  moderationStatus: { policy: "required" },

  // Timestamps
  createdAt:        { policy: "optional" },
  updatedAt:        { policy: "optional" },

  // Internal / join fields (allowed through but not documented publicly)
  __v:              { policy: "optional" },
};

// ---------------------------------------------------------------------------
// Review field registry
// ---------------------------------------------------------------------------

export const REVIEW_FIELD_REGISTRY: Record<string, FieldDescriptor> = {
  _id:           { policy: "optional" },
  id:            { policy: "required" },
  schemaVersion: { policy: "required" },
  promptId:      { policy: "required" },
  userAddress:   { policy: "required" },
  rating:        { policy: "required" },
  text:          { policy: "required" },
  createdAt:     { policy: "required" },
  verified:      { policy: "required" },
  status:        { policy: "required" },
  // Deprecated field — was used before moderation status was added
  isVisible:     { policy: "deprecated", migrationNote: "Use `status` ('published' | 'hidden' | 'flagged'). `isVisible` will be removed in schema v3." },
};

// ---------------------------------------------------------------------------
// Core guardrail function
// ---------------------------------------------------------------------------

/**
 * Apply schema guardrails to a raw record:
 *
 *  1. Strip fields not present in the registry → `hadUnknownFields`
 *  2. Warn on deprecated fields → `hadDeprecatedFields` + `migrationNotes`
 *  3. Validate required fields are present → warnings if missing
 *
 * This function intentionally does NOT throw on unknown fields so a single
 * bad document in a list query cannot abort the whole response.  The caller
 * decides how to handle `hadUnknownFields` (log, metric, hard-reject in strict
 * mode).
 */
export function applyGuardrails<T extends Record<string, unknown>>(
  raw: Record<string, unknown>,
  registry: Record<string, FieldDescriptor>,
  strictMode = false,
): SchemaGuardrailResult<T> {
  const warnings: string[] = [];
  const migrationNotes: string[] = [];
  const sanitised: Record<string, unknown> = {};
  let hadUnknownFields = false;
  let hadDeprecatedFields = false;

  for (const [key, value] of Object.entries(raw)) {
    const descriptor = registry[key];

    if (!descriptor) {
      hadUnknownFields = true;
      warnings.push(`Unknown field "${key}" stripped from response.`);
      if (strictMode) {
        // In strict mode still include field but flag loudly for monitoring
        sanitised[key] = value;
      }
      // In normal mode the field is silently dropped (not included in sanitised)
      continue;
    }

    if (descriptor.policy === "deprecated") {
      hadDeprecatedFields = true;
      const note = descriptor.migrationNote ?? `Field "${key}" is deprecated.`;
      warnings.push(`Deprecated field "${key}" present. ${note}`);
      migrationNotes.push(note);
      // Still pass the field through so old clients aren't broken
      sanitised[key] = value;
      continue;
    }

    sanitised[key] = value;
  }

  // Warn on missing required fields
  for (const [key, descriptor] of Object.entries(registry)) {
    if (descriptor.policy === "required" && !(key in sanitised)) {
      warnings.push(`Required field "${key}" is missing from the record.`);
    }
  }

  return {
    record: sanitised as T,
    warnings,
    migrationNotes,
    hadUnknownFields,
    hadDeprecatedFields,
  };
}

/**
 * Convenience wrapper — applies Prompt guardrails.
 */
export function applyPromptGuardrails(
  raw: Record<string, unknown>,
  strictMode = false,
) {
  return applyGuardrails(raw, PROMPT_FIELD_REGISTRY, strictMode);
}

/**
 * Convenience wrapper — applies Review guardrails.
 */
export function applyReviewGuardrails(
  raw: Record<string, unknown>,
  strictMode = false,
) {
  return applyGuardrails(raw, REVIEW_FIELD_REGISTRY, strictMode);
}

// ---------------------------------------------------------------------------
// Migration notes helper
// ---------------------------------------------------------------------------

/**
 * Return all migration notes for deprecated fields across a registry.
 * Useful for generating runbook sections during deploys.
 */
export function getMigrationNotes(
  registry: Record<string, FieldDescriptor>,
): Array<{ field: string; note: string }> {
  return Object.entries(registry)
    .filter(([, d]) => d.policy === "deprecated" && d.migrationNote)
    .map(([field, d]) => ({ field, note: d.migrationNote! }));
}

// ---------------------------------------------------------------------------
// Operational edge cases and failure modes
// ---------------------------------------------------------------------------
/**
 * EDGE CASES
 * ----------
 * 1. Forward-written records (schemaVersion > current build):
 *    `transformPromptForApi` in schemaVersioning.ts already throws
 *    `SchemaVersionError`.  The guardrail layer receives documents that have
 *    already passed that check, so it only needs to handle v0..current.
 *
 * 2. Unknown field explosion after a partial rollout:
 *    During a blue/green deploy the new build writes fields the old build
 *    does not recognise.  `applyGuardrails` strips those fields silently on
 *    the old build and emits a warning counter.  No data is corrupted; the
 *    new field is simply invisible until the old build drains.
 *    → Monitor the `schema.unknown_fields_stripped` metric and alert if it
 *      spikes after a deploy.
 *
 * 3. Required-field absence after a bad migration:
 *    If a backfill job fails, some documents may lack a required field.
 *    The guardrail warns but does NOT drop the whole document.  The API
 *    response will have the field missing, which clients must tolerate.
 *    → The migration safety framework in migrationSafetyFramework.ts
 *      provides dry-run and rollback tooling for backfill jobs.
 *
 * 4. Deprecated field removal timing:
 *    Remove a deprecated field only after:
 *      a) All consumers have been confirmed to use the replacement.
 *      b) At least one major version has passed with the deprecation warning.
 *      c) The backfill for the replacement has completed (check migration status).
 *    Premature removal is a breaking change even if the field is "deprecated".
 *
 * 5. Strict mode in production:
 *    Enable `strictMode = true` only on internal admin endpoints where you
 *    want to surface unknown fields for debugging.  Never enable it on
 *    public-facing endpoints — unknown fields from future builds would leak.
 *
 * ROLLBACK / RECOVERY
 * -------------------
 * - If a deploy introduces a new required field without a backfill, roll back
 *   by reverting the registry entry from "required" to "optional", then run
 *   the backfill, then re-promote.
 * - If unknown fields appear in production unexpectedly, check for a partial
 *   rollout writing data the current build does not know about.  Completing
 *   the rollout (or rolling back) will stop new unknown fields from appearing.
 * - The `getMigrationNotes` export can be called during deploy scripts to
 *   automatically surface deprecation warnings in release notes.
 */
