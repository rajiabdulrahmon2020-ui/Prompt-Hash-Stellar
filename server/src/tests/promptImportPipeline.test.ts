import { describe, it, expect } from "vitest";
import {
  ImportPreviewMismatchError,
  commitPromptImport,
  computeRowRef,
  createMemoryImportStore,
  previewPromptImport,
  rollbackPromptImport,
  type StoredImportedPrompt,
} from "../services/promptImportPipeline";
import type { PromptImportRow } from "../services/promptImport";

function makeRow(overrides: Record<string, unknown> = {}): PromptImportRow {
  return {
    externalId: "catalog-1",
    creatorWallet: "GCREATOR",
    title: "A valid prompt",
    category: "Programming",
    image: "https://example.com/p.png",
    price: 1,
    payloadRef: "opaque-ref",
    ...overrides,
  } as unknown as PromptImportRow;
}

function seedRecord(
  externalId: string,
  creatorWallet: string,
  overrides: Partial<StoredImportedPrompt> = {},
): StoredImportedPrompt {
  return {
    externalId,
    creatorWallet,
    importId: "prev_import_0",
    rowRef: "row_seed",
    origin: "created",
    previousRecord: null,
    row: makeRow({ externalId, creatorWallet }),
    ...overrides,
  };
}

describe("previewPromptImport", () => {
  it("classifies rows and quarantines each failure with stable reason codes", () => {
    const preview = previewPromptImport([
      makeRow({ externalId: "catalog-1" }),
      makeRow({ externalId: "catalog-1" }), // duplicate
      makeRow({ externalId: "catalog-2", title: "" }), // invalid metadata (title below min length)
      makeRow({ externalId: "catalog-3", creatorWallet: "" }), // missing creator
      makeRow({ externalId: undefined, payloadRef: undefined }), // missing identity
    ]);

    expect(preview.counts.create).toBe(1);
    expect(preview.counts.update).toBe(0);
    expect(preview.counts.quarantine).toBe(4);

    const reasons = preview.quarantined.flatMap((row) => row.reasonCodes);
    expect(reasons).toContain("duplicate_row");
    expect(reasons).toContain("invalid_metadata");
    expect(reasons).toContain("missing_creator");
    expect(reasons).toContain("missing_identity");
  });

  it("quarantines ownership mismatches instead of overwriting another creator's row", () => {
    const preview = previewPromptImport(
      [makeRow({ externalId: "catalog-1", creatorWallet: "GATTACKER" })],
      [{ externalId: "catalog-1", creatorWallet: "GCREATOR" }],
    );

    expect(preview.counts.update).toBe(0);
    expect(preview.quarantined[0].reasonCodes).toEqual(["ownership_mismatch"]);
  });

  it("quarantines rows carrying secrets or prompt plaintext as unsafe_payload", () => {
    const unsafe = {
      ...makeRow({ externalId: "catalog-9" }),
      secret: "SPSECRET",
      nested: { encryptedPrompt: "cipher" },
    } as unknown as PromptImportRow;

    const preview = previewPromptImport([unsafe]);

    expect(preview.counts.create).toBe(0);
    expect(preview.quarantined[0].reasonCodes).toEqual(["unsafe_payload"]);
  });

  it("never echoes raw payload references and has a deterministic previewId", () => {
    const rows = [makeRow()];

    const first = previewPromptImport(
      rows,
      [],
      new Date("2026-02-01T00:00:00Z"),
    );
    const second = previewPromptImport(
      rows,
      [],
      new Date("2026-03-05T09:00:00Z"),
    );

    expect(JSON.stringify(first)).not.toContain("opaque-ref");
    expect(JSON.stringify(first)).not.toContain("GCREATOR");
    expect(first.previewId).toBe(second.previewId);
    expect(first.previewId).toMatch(/^prev_[a-f0-9]{40}$/);
  });

  it("changes the previewId when row content changes", () => {
    const base = previewPromptImport([makeRow()]);
    const changed = previewPromptImport([
      makeRow({ title: "A different title" }),
    ]);
    expect(base.previewId).not.toBe(changed.previewId);
  });
});

describe("commitPromptImport", () => {
  it("refuses to commit when the previewId does not match the supplied rows", async () => {
    const store = createMemoryImportStore();
    const preview = previewPromptImport([makeRow()]);

    await expect(
      commitPromptImport(store, [makeRow({ title: "Edited after preview" })], {
        previewId: preview.previewId,
      }),
    ).rejects.toThrow(ImportPreviewMismatchError);
    expect(store.dump()).toHaveLength(0);
  });

  it("applies accepted rows with import traceability and quarantines the rest", async () => {
    const store = createMemoryImportStore([
      seedRecord("catalog-1", "GCREATOR"),
    ]);
    const rows = [
      makeRow({ externalId: "catalog-1", title: "Updated title" }),
      makeRow({ externalId: "catalog-2" }),
      makeRow({ externalId: "catalog-3", title: "" }),
    ];

    const preview = previewPromptImport(rows, await store.listExisting());
    const receipt = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
    });

    expect(receipt.rows.map((row) => row.action)).toEqual([
      "updated",
      "created",
    ]);
    expect(receipt.quarantined).toHaveLength(1);
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);

    const updated = store
      .dump()
      .find((record) => record.externalId === "catalog-1")!;
    expect(updated.importId).toBe(preview.previewId);
    expect(updated.origin).toBe("updated");
    expect(updated.previousRecord?.rowRef).toBe("row_seed");
    expect(updated.row.title).toBe("Updated title");

    const created = store
      .dump()
      .find((record) => record.externalId === "catalog-2")!;
    expect(created.importId).toBe(preview.previewId);
    expect(created.origin).toBe("created");
    expect(created.rowRef).toBe(
      computeRowRef(makeRow({ externalId: "catalog-2" })),
    );
  });

  it("is idempotent: a retried commit produces the same receipt and no duplicate writes", async () => {
    const store = createMemoryImportStore();
    const rows = [
      makeRow({ externalId: "catalog-1" }),
      makeRow({ externalId: "catalog-2" }),
    ];

    const preview = previewPromptImport(rows, await store.listExisting());
    const first = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
      now: new Date("2026-02-01T00:00:00Z"),
    });
    const dumpAfterFirst = JSON.stringify(store.dump());

    const second = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
      now: new Date("2026-02-01T00:05:00Z"),
    });

    expect(second.receiptHash).toBe(first.receiptHash);
    expect(second.rows).toEqual(first.rows);
    expect(JSON.stringify(store.dump())).toBe(dumpAfterFirst);
  });
});

describe("rollbackPromptImport", () => {
  it("restores updated rows from snapshots and deletes created rows", async () => {
    const before = seedRecord("catalog-1", "GCREATOR", {
      importId: "prev_import_0",
    });
    const store = createMemoryImportStore([before]);
    const rows = [
      makeRow({ externalId: "catalog-1", title: "Updated title" }),
      makeRow({ externalId: "catalog-2" }),
    ];

    const preview = previewPromptImport(rows, await store.listExisting());
    const receipt = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
    });
    expect(store.dump()).toHaveLength(2);

    const report = await rollbackPromptImport(store, receipt);

    expect(report.reverted).toBe(2);
    const restored = store.dump();
    expect(restored).toHaveLength(1);
    expect(restored[0].externalId).toBe("catalog-1");
    expect(restored[0].importId).toBe("prev_import_0");
    expect(restored[0].row.title).toBe("A valid prompt");
  });

  it("is idempotent on a second rollback", async () => {
    const store = createMemoryImportStore();
    const rows = [makeRow({ externalId: "catalog-1" })];
    const preview = previewPromptImport(rows, await store.listExisting());
    const receipt = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
    });

    await rollbackPromptImport(store, receipt);
    const second = await rollbackPromptImport(store, receipt);

    expect(second.reverted).toBe(0);
    expect(second.skipped).toEqual([
      { externalId: "catalog-1", reason: "missing" },
    ]);
  });

  it("never clobbers rows touched by a later import (superseded)", async () => {
    const store = createMemoryImportStore();
    const rows = [makeRow({ externalId: "catalog-1" })];
    const preview = previewPromptImport(rows, await store.listExisting());
    const receipt = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
    });

    // A later, different import rewrites the same row.
    const laterRecord: StoredImportedPrompt = {
      ...store.dump()[0],
      importId: "prev_later_import",
      row: makeRow({
        externalId: "catalog-1",
        title: "Changed by later import",
      }),
    };
    await store.put(laterRecord);

    const report = await rollbackPromptImport(store, receipt);

    expect(report.reverted).toBe(0);
    expect(report.skipped).toEqual([
      { externalId: "catalog-1", reason: "superseded" },
    ]);
    expect(store.dump()[0].row.title).toBe("Changed by later import");
  });

  it("skips update rows with a missing snapshot instead of deleting them", async () => {
    const store = createMemoryImportStore([
      seedRecord("catalog-1", "GCREATOR"),
    ]);
    const rows = [makeRow({ externalId: "catalog-1" })];
    const preview = previewPromptImport(rows, await store.listExisting());
    const receipt = await commitPromptImport(store, rows, {
      previewId: preview.previewId,
    });

    // Simulate a corrupted trace where the snapshot was lost.
    const record = store.dump()[0];
    await store.put({ ...record, previousRecord: null });

    const report = await rollbackPromptImport(store, receipt);

    expect(report.reverted).toBe(0);
    expect(report.skipped).toEqual([
      { externalId: "catalog-1", reason: "missing_snapshot" },
    ]);
    expect(store.dump()).toHaveLength(1);
  });
});
