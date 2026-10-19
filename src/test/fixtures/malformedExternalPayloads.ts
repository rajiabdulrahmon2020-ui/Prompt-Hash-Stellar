/**
 * Golden fixture corpus for malformed external payloads — Issue #965.
 *
 * Checked-in adversarial records covering invalid signatures, missing
 * fields, oversized values, replays, and schema drift. Pure data (no
 * imports) so frontend, server, and SDK suites can all consume it.
 * Executed by `src/test/malformedExternalPayloads.test.ts`, which runs
 * each fixture through the real validators (challenge, listing, decoder)
 * and asserts fail-closed / quarantine behavior.
 */

export type MalformedCategory =
  | "invalid-signatures"
  | "missing-fields"
  | "oversized-values"
  | "replays"
  | "schema-drift";

export type MalformedDecision = "reject" | "quarantine";

export interface MalformedFixture {
  id: string;
  category: MalformedCategory;
  description: string;
  payload: unknown;
  expected: { decision: MalformedDecision; code: string };
}

export const MALFORMED_FIXTURES: MalformedFixture[] = [
  // ── Invalid signatures ──────────────────────────────────────────────
  {
    id: "sig-forged-signer",
    category: "invalid-signatures",
    description: "Wallet signature from a key that does not own the challenge address",
    payload: { kind: "signedMessage", signedBy: "attacker", claimedAddress: "victim" },
    expected: { decision: "reject", code: "INVALID_SIGNATURE" },
  },
  {
    id: "sig-hmac-tampered-token",
    category: "invalid-signatures",
    description: "Challenge token payload re-encoded with an invalid HMAC signature",
    payload: { kind: "challengeToken", tampered: true },
    expected: { decision: "reject", code: "INVALID_SIGNATURE" },
  },
  {
    id: "sig-garbage-base64",
    category: "invalid-signatures",
    description: "Non-base64 signature bytes that must fail verification without throwing",
    payload: { kind: "rawSignature", value: "!!!not-base64!!!" },
    expected: { decision: "reject", code: "INVALID_SIGNATURE" },
  },
  // ── Missing fields ──────────────────────────────────────────────────
  {
    id: "missing-unlock-token",
    category: "missing-fields",
    description: "Unlock request omits the challenge token entirely",
    payload: { address: "GVALID", promptId: "42", token: "" },
    expected: { decision: "reject", code: "MISSING_FIELDS" },
  },
  {
    id: "missing-listing-title",
    category: "missing-fields",
    description: "Listing form with an empty title",
    payload: { field: "title", value: "" },
    expected: { decision: "reject", code: "VALIDATION_ERROR" },
  },
  {
    id: "missing-event-field",
    category: "missing-fields",
    description: "Contract event payload with a required field nulled",
    payload: { type: "PromptCreated", raw: { prompt_id: null, creator: null } },
    expected: { decision: "quarantine", code: "MALFORMED_EVENT" },
  },
  // ── Oversized values ────────────────────────────────────────────────
  {
    id: "oversized-encrypted-payload",
    category: "oversized-values",
    description: "Encrypted prompt one char over the 4096 on-chain limit",
    payload: { kind: "encryptedPrompt", length: 4097 },
    expected: { decision: "reject", code: "PAYLOAD_TOO_LARGE" },
  },
  {
    id: "oversized-wrapped-key",
    category: "oversized-values",
    description: "Wrapped AES key over the 256-char limit",
    payload: { kind: "wrappedKey", length: 300 },
    expected: { decision: "reject", code: "PAYLOAD_TOO_LARGE" },
  },
  {
    id: "oversized-full-prompt",
    category: "oversized-values",
    description: "Full prompt text whose estimated ciphertext exceeds the on-chain cap",
    payload: { kind: "fullPrompt", length: 10000 },
    expected: { decision: "reject", code: "PAYLOAD_TOO_LARGE" },
  },
  // ── Replays ─────────────────────────────────────────────────────────
  {
    id: "replay-consumed-nonce",
    category: "replays",
    description: "Same challenge token submitted twice (nonce already consumed)",
    payload: { kind: "challengeToken", reuse: "same-nonce-twice" },
    expected: { decision: "reject", code: "REPLAY_DETECTED" },
  },
  {
    id: "replay-cross-prompt",
    category: "replays",
    description: "Token issued for prompt 42 submitted against prompt 43",
    payload: { kind: "challengeToken", issuedFor: "42", submittedFor: "43" },
    expected: { decision: "reject", code: "REPLAY_DETECTED" },
  },
  // ── Schema drift ────────────────────────────────────────────────────
  {
    id: "drift-unknown-event-type",
    category: "schema-drift",
    description: "Event type from a future contract deploy this build does not know",
    payload: { type: "SomeFutureEventTypeNotYetDefined", raw: { foo: "bar" } },
    expected: { decision: "quarantine", code: "unknown_type" },
  },
  {
    id: "drift-unsupported-version",
    category: "schema-drift",
    description: "Known event with a future version number",
    payload: { type: "PromptCreated", raw: { prompt_id: 1, version: 99 }, version: 99 },
    expected: { decision: "quarantine", code: "unsupported_version" },
  },
  {
    id: "drift-truncated-topic",
    category: "schema-drift",
    description: "Null/malformed topic envelope that must quarantine, not crash",
    payload: { type: "", raw: null },
    expected: { decision: "quarantine", code: "unknown_type" },
  },
];
