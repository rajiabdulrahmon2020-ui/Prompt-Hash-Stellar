import { describe, expect, it } from "vitest";
import { decodeEvent } from "./decode.js";
import { EVENT_SCHEMAS } from "./schema.js";
import { CONTRACT_MAP, INTEGRATION_BOUNDARIES } from "./contractMap.js";

describe("contractMap (issue #984)", () => {
  it("covers every EVENT_SCHEMAS entry with producer/consumer/version/failure", () => {
    for (const name of Object.keys(EVENT_SCHEMAS)) {
      const mapEntry = CONTRACT_MAP[name];
      expect(mapEntry, `missing CONTRACT_MAP entry for "${name}"`).toBeDefined();
      expect(mapEntry.producer.length).toBeGreaterThan(0);
      expect(mapEntry.consumers.length).toBeGreaterThan(0);
      expect(mapEntry.supportedVersions.length).toBeGreaterThan(0);
      expect(mapEntry.onFailure.length).toBeGreaterThan(0);
      expect(mapEntry.delivery).toBe("at-least-once");
    }
    expect(Object.keys(CONTRACT_MAP).sort()).toEqual(Object.keys(EVENT_SCHEMAS).sort());
  });

  it("derives required fields from EVENT_SCHEMAS so the map cannot drift", () => {
    for (const [name, mapEntry] of Object.entries(CONTRACT_MAP)) {
      expect(mapEntry.requiredFields).toEqual(EVENT_SCHEMAS[name].fields.map((f) => f.name));
    }
  });

  it("routes unknown types and unsupported versions to quarantine (never throws)", () => {
    const unknown = decodeEvent("SomeFutureEvent", { foo: 1 });
    expect(unknown.recognized).toBe(false);
    if (!unknown.recognized) expect(unknown.reason).toBe("unknown_type");

    const future = decodeEvent("PromptCreated", { prompt_id: 1n }, 99);
    expect(future.recognized).toBe(false);
    if (!future.recognized) expect(future.reason).toBe("unsupported_version");
  });

  it("covers hash-proof, entitlement, and settlement integration boundaries", () => {
    const domains = new Set(INTEGRATION_BOUNDARIES.map((b) => b.domain));
    expect(domains.has("hash-proofs")).toBe(true);
    expect(domains.has("entitlements")).toBe(true);
    expect(domains.has("settlement")).toBe(true);
    for (const b of INTEGRATION_BOUNDARIES) {
      expect(b.producer.length).toBeGreaterThan(0);
      expect(b.consumer.length).toBeGreaterThan(0);
      expect(b.requiredFields.length).toBeGreaterThan(0);
      expect(b.versionRule.length).toBeGreaterThan(0);
    }
  });
});
