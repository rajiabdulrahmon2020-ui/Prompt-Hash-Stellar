/**
 * Schema Evolution Guardrail Tests — Issue #970
 *
 * Verifies that the guardrail layer:
 *   • strips unknown fields added by newer builds
 *   • warns on deprecated fields and surfaces migration notes
 *   • warns when required fields are absent
 *   • passes clean current-version records without any warnings
 *   • behaves correctly in strict mode
 *   • getMigrationNotes returns all deprecated-field notes
 */

import { describe, it, expect } from "vitest";
import {
  applyPromptGuardrails,
  applyReviewGuardrails,
  applyGuardrails,
  getMigrationNotes,
  PROMPT_FIELD_REGISTRY,
  REVIEW_FIELD_REGISTRY,
} from "../services/schemaGuardrails";
import {
  CURRENT_PROMPT_SCHEMA_VERSION,
  CURRENT_REVIEW_SCHEMA_VERSION,
} from "../services/schemaVersioning";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanPrompt: Record<string, unknown> = {
  _id: "p1",
  schemaVersion: CURRENT_PROMPT_SCHEMA_VERSION,
  title: "Test Prompt",
  category: "Development",
  description: "A test prompt",
  tags: ["gpt", "code"],
  licence: "standard",
  lifecycleState: "published",
  moderationStatus: "none",
};

const cleanReview: Record<string, unknown> = {
  id: "r1",
  schemaVersion: CURRENT_REVIEW_SCHEMA_VERSION,
  promptId: "p1",
  userAddress: "GBUYER0000000000000000000000000000001",
  rating: 5,
  text: "Great prompt",
  createdAt: Date.now(),
  verified: true,
  status: "published",
};

// ---------------------------------------------------------------------------
// Unknown field stripping
// ---------------------------------------------------------------------------

describe("applyPromptGuardrails — unknown fields", () => {
  it("strips a single unrecognised field from a prompt record", () => {
    const raw = { ...cleanPrompt, futureFeatureFlag: true };
    const { record, hadUnknownFields, warnings } = applyPromptGuardrails(raw);

    expect("futureFeatureFlag" in record).toBe(false);
    expect(hadUnknownFields).toBe(true);
    expect(warnings.some((w) => w.includes("futureFeatureFlag"))).toBe(true);
  });

  it("strips multiple unrecognised fields in one pass", () => {
    const raw = { ...cleanPrompt, fieldA: 1, fieldB: "x", fieldC: null };
    const { record, warnings } = applyPromptGuardrails(raw);

    expect("fieldA" in record).toBe(false);
    expect("fieldB" in record).toBe(false);
    expect("fieldC" in record).toBe(false);
    expect(warnings).toHaveLength(3); // one warning per unknown field
  });

  it("does NOT strip unknown fields when strictMode is true", () => {
    const raw = { ...cleanPrompt, debugOnlyField: "secret" };
    const { record, hadUnknownFields } = applyPromptGuardrails(raw, true);

    // Field is retained in strict mode for debugging
    expect("debugOnlyField" in record).toBe(true);
    expect(hadUnknownFields).toBe(true);
  });

  it("returns hadUnknownFields=false and no warnings for a clean record", () => {
    const { hadUnknownFields, warnings } = applyPromptGuardrails(cleanPrompt);
    expect(hadUnknownFields).toBe(false);
    // Only check no unknown-field warnings (there may be optional-field absence notes)
    expect(warnings.every((w) => !w.includes("stripped"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deprecated field handling
// ---------------------------------------------------------------------------

describe("applyPromptGuardrails — deprecated fields", () => {
  it("passes deprecated `image` field through but emits a warning", () => {
    const raw = { ...cleanPrompt, image: "https://example.com/img.png" };
    const { record, hadDeprecatedFields, warnings, migrationNotes } =
      applyPromptGuardrails(raw);

    // Field still present (backward compat)
    expect(record.image).toBe("https://example.com/img.png");
    expect(hadDeprecatedFields).toBe(true);
    expect(warnings.some((w) => w.includes("image"))).toBe(true);
    expect(migrationNotes.some((n) => n.includes("imageUrl"))).toBe(true);
  });

  it("passes deprecated `price` field through with migration note", () => {
    const raw = { ...cleanPrompt, price: 5 };
    const { record, migrationNotes } = applyPromptGuardrails(raw);

    expect(record.price).toBe(5);
    expect(migrationNotes.some((n) => n.includes("priceStroops"))).toBe(true);
  });

  it("passes deprecated `isActive` field through with correct migration note", () => {
    const raw = { ...cleanPrompt, isActive: true };
    const { record, migrationNotes } = applyPromptGuardrails(raw);

    expect(record.isActive).toBe(true);
    expect(migrationNotes.some((n) => n.includes("`active`"))).toBe(true);
  });

  it("passes deprecated `listingStatus` with migration note pointing to lifecycleState", () => {
    const raw = { ...cleanPrompt, listingStatus: "published" };
    const { migrationNotes } = applyPromptGuardrails(raw);

    expect(migrationNotes.some((n) => n.includes("lifecycleState"))).toBe(true);
  });

  it("returns hadDeprecatedFields=false when no deprecated fields present", () => {
    const { hadDeprecatedFields } = applyPromptGuardrails(cleanPrompt);
    expect(hadDeprecatedFields).toBe(false);
  });
});

describe("applyReviewGuardrails — deprecated fields", () => {
  it("passes deprecated `isVisible` through with status migration note", () => {
    const raw = { ...cleanReview, isVisible: true };
    const { record, hadDeprecatedFields, migrationNotes } =
      applyReviewGuardrails(raw);

    expect(record.isVisible).toBe(true);
    expect(hadDeprecatedFields).toBe(true);
    expect(migrationNotes.some((n) => n.includes("`status`"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing required fields
// ---------------------------------------------------------------------------

describe("applyPromptGuardrails — missing required fields", () => {
  it("warns when `title` is absent", () => {
    const { record: rawWithoutTitle, ...rest } = cleanPrompt;
    const incomplete: Record<string, unknown> = { ...cleanPrompt };
    delete incomplete.title;

    const { warnings } = applyPromptGuardrails(incomplete);
    expect(warnings.some((w) => w.includes('"title"') && w.includes("missing"))).toBe(true);
  });

  it("warns when `lifecycleState` is absent", () => {
    const incomplete: Record<string, unknown> = { ...cleanPrompt };
    delete incomplete.lifecycleState;

    const { warnings } = applyPromptGuardrails(incomplete);
    expect(warnings.some((w) => w.includes('"lifecycleState"'))).toBe(true);
  });

  it("warns when `schemaVersion` is absent", () => {
    const incomplete: Record<string, unknown> = { ...cleanPrompt };
    delete incomplete.schemaVersion;

    const { warnings } = applyPromptGuardrails(incomplete);
    expect(warnings.some((w) => w.includes('"schemaVersion"'))).toBe(true);
  });
});

describe("applyReviewGuardrails — missing required fields", () => {
  it("warns when `rating` is absent", () => {
    const incomplete: Record<string, unknown> = { ...cleanReview };
    delete incomplete.rating;

    const { warnings } = applyReviewGuardrails(incomplete);
    expect(warnings.some((w) => w.includes('"rating"'))).toBe(true);
  });

  it("warns when `status` is absent", () => {
    const incomplete: Record<string, unknown> = { ...cleanReview };
    delete incomplete.status;

    const { warnings } = applyReviewGuardrails(incomplete);
    expect(warnings.some((w) => w.includes('"status"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clean (current-version) records produce no warnings
// ---------------------------------------------------------------------------

describe("applyPromptGuardrails — clean records", () => {
  it("produces no warnings and no flags for a fully-populated current prompt", () => {
    const { warnings, hadUnknownFields, hadDeprecatedFields } =
      applyPromptGuardrails(cleanPrompt);

    expect(hadUnknownFields).toBe(false);
    expect(hadDeprecatedFields).toBe(false);
    // May have warnings about optional fields absent — but no unknown/deprecated/required
    const problemWarnings = warnings.filter(
      (w) => w.includes("stripped") || w.includes("Deprecated"),
    );
    expect(problemWarnings).toHaveLength(0);
  });
});

describe("applyReviewGuardrails — clean records", () => {
  it("produces no warnings and no flags for a fully-populated current review", () => {
    const { warnings, hadUnknownFields, hadDeprecatedFields } =
      applyReviewGuardrails(cleanReview);

    expect(hadUnknownFields).toBe(false);
    expect(hadDeprecatedFields).toBe(false);
    const problemWarnings = warnings.filter(
      (w) => w.includes("stripped") || w.includes("Deprecated"),
    );
    expect(problemWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getMigrationNotes
// ---------------------------------------------------------------------------

describe("getMigrationNotes", () => {
  it("returns entries for all deprecated Prompt fields", () => {
    const notes = getMigrationNotes(PROMPT_FIELD_REGISTRY);
    const fields = notes.map((n) => n.field);

    expect(fields).toContain("image");
    expect(fields).toContain("price");
    expect(fields).toContain("isActive");
    expect(fields).toContain("listingStatus");
  });

  it("does not include required or optional fields in migration notes", () => {
    const notes = getMigrationNotes(PROMPT_FIELD_REGISTRY);
    const fields = notes.map((n) => n.field);

    expect(fields).not.toContain("title");
    expect(fields).not.toContain("schemaVersion");
    expect(fields).not.toContain("tags");
  });

  it("returns entries for deprecated Review fields", () => {
    const notes = getMigrationNotes(REVIEW_FIELD_REGISTRY);
    expect(notes.some((n) => n.field === "isVisible")).toBe(true);
  });

  it("each note entry has a non-empty note string", () => {
    const notes = getMigrationNotes(PROMPT_FIELD_REGISTRY);
    notes.forEach(({ note }) => {
      expect(typeof note).toBe("string");
      expect(note.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Generic applyGuardrails edge cases
// ---------------------------------------------------------------------------

describe("applyGuardrails — generic edge cases", () => {
  it("handles an empty record gracefully", () => {
    const { record, warnings, hadUnknownFields } = applyGuardrails(
      {},
      PROMPT_FIELD_REGISTRY,
    );
    expect(hadUnknownFields).toBe(false);
    // Required-field warnings should be present
    expect(warnings.some((w) => w.includes("missing"))).toBe(true);
  });

  it("handles a record with only unknown fields", () => {
    const { record, hadUnknownFields, warnings } = applyGuardrails(
      { unknownA: 1, unknownB: 2 },
      PROMPT_FIELD_REGISTRY,
    );
    expect(hadUnknownFields).toBe(true);
    expect(Object.keys(record)).toHaveLength(0);
    expect(warnings.filter((w) => w.includes("stripped"))).toHaveLength(2);
  });

  it("is idempotent — applying guardrails twice produces the same result", () => {
    const first = applyPromptGuardrails({ ...cleanPrompt, mystery: 42 });
    const second = applyPromptGuardrails(first.record as Record<string, unknown>);

    // Second pass: mystery was already stripped, so no new unknown warnings
    expect(second.hadUnknownFields).toBe(false);
    expect(JSON.stringify(first.record)).toBe(JSON.stringify(second.record));
  });
});
