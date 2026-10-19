// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createChallengeToken,
  verifyChallengeSignature,
  verifyChallengeToken,
  buildChallengeMessage,
} from "@/lib/auth/challenge";
import {
  validateEncryptedPayload,
  validateListingForm,
  wouldExceedPayloadLimit,
  LISTING_LIMITS,
} from "@/lib/validation/listing";
import { decodeEvent } from "../../packages/sdk/src/events/decode.js";
import { MALFORMED_FIXTURES } from "./fixtures/malformedExternalPayloads";

const SECRET = "golden-corpus-test-secret";
const NOW = 1_700_000_000_000;

function validForm() {
  return {
    imageUrl: "https://example.com/cover.png",
    title: "Campaign launch pack",
    category: "Marketing",
    previewText: "Public preview text for buyers browsing the marketplace.",
    fullPrompt: "Private prompt body with enough content for validation.",
    priceXlm: "2.5",
    coCreators: [],
  };
}

describe("malformed external payload corpus (issue #965)", () => {
  it("covers invalid signatures, missing fields, oversized values, replays, and schema drift", () => {
    const cats = new Set(MALFORMED_FIXTURES.map((f) => f.category));
    for (const c of ["invalid-signatures", "missing-fields", "oversized-values", "replays", "schema-drift"]) {
      expect(cats.has(c as never)).toBe(true);
    }
    expect(MALFORMED_FIXTURES.length).toBeGreaterThanOrEqual(14);
  });

  it("rejects forged and garbage signatures without leaking plaintext", () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const challenge = createChallengeToken(SECRET, victim.publicKey(), "42", NOW);
    const payload = verifyChallengeToken(SECRET, challenge.token, victim.publicKey(), "42", NOW + 1000);
    const message = buildChallengeMessage(payload);
    const forged = Buffer.from(attacker.sign(Buffer.from(message, "utf8"))).toString("base64");
    expect(verifyChallengeSignature(victim.publicKey(), message, forged)).toBe(false);
    expect(verifyChallengeSignature(victim.publicKey(), message, "!!!not-base64!!!")).toBe(false);
    expect(() =>
      verifyChallengeToken(SECRET, `${challenge.token.split(".")[0]}.tampered`, victim.publicKey(), "42", NOW + 1000),
    ).toThrow(/Invalid challenge token signature/);
  });

  it("rejects missing required fields fail-closed", () => {
    expect(validateListingForm({ ...validForm(), title: "" }).title).toBeTruthy();
    const missing = MALFORMED_FIXTURES.find((f) => f.id === "missing-unlock-token")!;
    expect(missing.expected).toEqual({ decision: "reject", code: "MISSING_FIELDS" });
  });

  it("rejects oversized values before chain submission", () => {
    expect(
      validateEncryptedPayload({ encryptedPrompt: "x".repeat(LISTING_LIMITS.encryptedPayload + 1), wrappedKey: "k", encryptionIv: "iv" }).encryptedPrompt,
    ).toBeTruthy();
    expect(
      validateEncryptedPayload({ encryptedPrompt: "c", wrappedKey: "k".repeat(LISTING_LIMITS.wrappedKey + 1), encryptionIv: "iv" }).wrappedKey,
    ).toBeTruthy();
    expect(wouldExceedPayloadLimit(10_000)).toBe(true);
  });

  it("binds challenges so cross-prompt replay fails", () => {
    const kp = Keypair.random();
    const challenge = createChallengeToken(SECRET, kp.publicKey(), "42", NOW);
    expect(() => verifyChallengeToken(SECRET, challenge.token, kp.publicKey(), "43", NOW + 1000)).toThrow(
      /does not match/,
    );
  });

  it("quarantines schema drift instead of throwing", () => {
    for (const f of MALFORMED_FIXTURES.filter((x) => x.category === "schema-drift")) {
      const p = f.payload as { type: string; raw: unknown; version?: number };
      const result = decodeEvent(p.type, p.raw, p.version ?? 1);
      expect(result.recognized).toBe(false);
      if (!result.recognized) expect(f.expected.code).toContain(result.reason);
    }
  });
});
