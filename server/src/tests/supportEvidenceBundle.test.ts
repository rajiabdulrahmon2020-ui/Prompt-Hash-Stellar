import { createHash } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import SupportCase from "../models/SupportCase";
import Purchase from "../models/Purchase";
import { AuditLog } from "../models/AuditLog";
import { computeRecordHash, hashWalletAddress } from "../services/auditTrail";
import {
  EVIDENCE_PURCHASE_LIMIT,
  EVIDENCE_TARGET_TYPE,
  EvidenceAnchorError,
  exportSupportEvidenceBundle,
  manifestChecksumOf,
  verifySupportEvidenceBundle,
} from "../services/supportEvidenceBundle";

const BUYER = "GBUYERWALLETADDRESSFORTESTSXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const CREATOR = "GCREATORWALLETADDRESSFORTESTSXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const CASE_ID = "65f0000000000000000000aa";
const TX_HASH = "a".repeat(64);
const SECRET_URL = "https://files.example.com/receipt.png?token=s3cr3t-signed-url";
const PRIVATE_NOTE = "Buyer phone +1 555 0100, email jane@example.com";
const DESCRIPTION = "Paid but unlock says no access. My email is jane@example.com";
const CLIENT_IP = "203.0.113.7";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Minimal append-only, hash-chained audit store standing in for MongoDB. */
let store: any[] = [];

function seedAuditRows(count: number) {
  let previousHash = store.at(-1)?.recordHash ?? "0".repeat(64);
  for (let i = 0; i < count; i++) {
    const row: any = {
      _id: `65f1000000000000000000${String(i).padStart(2, "0")}`,
      action: "unlock_no_access",
      result: "failure",
      promptId: "42",
      walletAddress: hashWalletAddress(BUYER),
      actor: null,
      requestId: `req-${i}`,
      reason: "has_access returned false",
      clientIp: CLIENT_IP,
      metadata: { signedMessage: "raw-signature" },
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      previousHash,
      integrityVersion: 2,
    };
    row.recordHash = computeRecordHash(row);
    previousHash = row.recordHash;
    store.push(row);
  }
}

function matches(row: any, query: Record<string, unknown>) {
  return Object.entries(query).every(([key, value]) => row[key] === value);
}

function installAuditStore() {
  vi.spyOn(AuditLog, "find").mockImplementation(((query: any) => {
    if (query?.recordHash) {
      const wanted = new Set(query.recordHash.$in);
      return { lean: async () => store.filter((row) => wanted.has(row.recordHash)) };
    }
    const chain: any = {
      sort: () => chain,
      limit: (n: number) => ((chain.n = n), chain),
      lean: () => chain,
      cursor: () => store.filter((row) => row.action !== "audit_export").slice(0, chain.n),
    };
    return chain;
  }) as any);
  vi.spyOn(AuditLog, "findOne").mockImplementation(((query?: any) => ({
    sort: () => ({ lean: async () => store.at(-1) ?? null }),
    lean: async () => store.find((row) => matches(row, query)) ?? null,
  })) as any);
  vi.spyOn(AuditLog, "create").mockImplementation((async (doc: any) => {
    const row = { _id: `65f20000000000000000${String(store.length).padStart(4, "0")}`, ...doc };
    store.push(row);
    return row;
  }) as any);
}

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: CASE_ID,
    type: "access_denied",
    status: "in_progress",
    promptId: "42",
    buyerWallet: BUYER.toLowerCase(),
    creatorWallet: CREATOR.toLowerCase(),
    title: "Cannot unlock",
    description: DESCRIPTION,
    notes: [
      { author: BUYER.toLowerCase(), isPrivate: true, text: PRIVATE_NOTE, createdAt: new Date("2026-10-02T00:00:00Z") },
    ],
    evidenceUrls: [SECRET_URL],
    assignedTo: "support-agent-7",
    createdAt: new Date("2026-10-01T12:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"),
    ...overrides,
  };
}

function purchaseRow(index: number) {
  return {
    _id: `65f30000000000000000${String(index).padStart(4, "0")}`,
    promptId: "42",
    buyerWallet: BUYER.toLowerCase(),
    versionIndex: 0,
    txHash: TX_HASH,
    status: "purchased",
    licenseVersionIndex: 1,
    licenseSnapshotId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
  };
}

function mockCase(row: unknown) {
  vi.spyOn(SupportCase, "findById").mockReturnValue({ lean: async () => row } as any);
}

function mockPurchases(rows: unknown[]) {
  const find = vi.spyOn(Purchase, "find").mockReturnValue({
    sort: () => ({ limit: (n: number) => ({ lean: async () => rows.slice(0, n) }) }),
  } as any);
  return find;
}

const context = { actor: "support-admin", requestId: "req-export" };

async function exportBundle() {
  const bundle = await exportSupportEvidenceBundle(CASE_ID, context);
  if (!bundle) throw new Error("expected a bundle");
  return bundle;
}

describe("support evidence bundles (#967)", () => {
  beforeEach(() => {
    store = [];
    seedAuditRows(3);
    installAuditStore();
    mockCase(caseRow());
    mockPurchases([purchaseRow(0)]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("redacts secrets and PII from every section", async () => {
    const body = JSON.stringify(await exportBundle());

    for (const forbidden of [
      BUYER,
      BUYER.toLowerCase(),
      CREATOR.toLowerCase(),
      "jane@example.com",
      "555 0100",
      "s3cr3t-signed-url",
      "support-agent-7",
      CLIENT_IP,
      "raw-signature",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("keeps the hashes, IDs, and timestamps needed to verify behavior", async () => {
    const bundle = await exportBundle();
    const buyerHash = hashWalletAddress(BUYER);

    expect(bundle.case).toMatchObject({
      caseId: CASE_ID,
      status: "in_progress",
      promptId: "42",
      buyerWalletHash: buyerHash,
      createdAt: "2026-10-01T12:00:00.000Z",
      description: { sha256: sha256(DESCRIPTION), length: DESCRIPTION.length },
    });
    expect(bundle.case.notes[0]).toMatchObject({
      isPrivate: true,
      authorHash: buyerHash,
      text: { sha256: sha256(PRIVATE_NOTE) },
    });
    expect(bundle.case.evidenceUrls[0].sha256).toBe(sha256(SECRET_URL));
    expect(bundle.purchases[0]).toMatchObject({ txHash: TX_HASH, buyerWalletHash: buyerHash });
    // Audit records correlate with the case through the shared wallet hash.
    expect(bundle.audit.recordCount).toBe(3);
    expect(bundle.audit.records.every((r) => r.walletHash === buyerHash)).toBe(true);
    expect(bundle.manifestChecksum).toBe(manifestChecksumOf(bundle));
  });

  it("anchors the manifest checksum in the audit trail", async () => {
    const bundle = await exportBundle();
    const anchor = store.at(-1);

    expect(anchor).toMatchObject({
      action: "audit_export",
      actor: "support-admin",
      target: CASE_ID,
      targetType: EVIDENCE_TARGET_TYPE,
      reason: `manifest=${bundle.manifestChecksum} records=3`,
    });
    expect(anchor.walletAddress).toBeNull();
  });

  it("verifies an untouched bundle", async () => {
    const result = await verifySupportEvidenceBundle(await exportBundle());
    expect(result).toMatchObject({ valid: true, manifestValid: true, anchored: true, errors: [] });
  });

  it("detects an edited bundle", async () => {
    const bundle = await exportBundle();
    bundle.case.status = "resolved";

    const result = await verifySupportEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.manifestValid).toBe(false);
  });

  it("detects an edit even when the checksum is recomputed", async () => {
    const bundle = await exportBundle();
    bundle.case.resolution = "refunded";
    bundle.manifestChecksum = manifestChecksumOf(bundle);

    const result = await verifySupportEvidenceBundle(bundle);
    expect(result).toMatchObject({ valid: false, manifestValid: true, anchored: false });
  });

  it("detects an edited audit record", async () => {
    const bundle = await exportBundle();
    bundle.audit.records[0].result = "success";
    bundle.manifestChecksum = manifestChecksumOf(bundle);

    const result = await verifySupportEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.audit.valid).toBe(false);
  });

  it("detects a tampered anchor record", async () => {
    const bundle = await exportBundle();
    store.at(-1).actor = "someone-else";

    expect((await verifySupportEvidenceBundle(bundle)).anchored).toBe(false);
  });

  it("refuses to release a bundle it cannot anchor", async () => {
    vi.spyOn(AuditLog, "create").mockRejectedValue(new Error("write concern timeout"));
    await expect(exportSupportEvidenceBundle(CASE_ID, context)).rejects.toBeInstanceOf(
      EvidenceAnchorError,
    );
  });

  it("is safe to retry: each export is anchored and verifies on its own", async () => {
    const first = await exportBundle();
    const second = await exportBundle();

    expect(store.filter((row) => row.action === "audit_export")).toHaveLength(2);
    expect((await verifySupportEvidenceBundle(first)).valid).toBe(true);
    expect((await verifySupportEvidenceBundle(second)).valid).toBe(true);
  });

  it("returns null for unknown or malformed case IDs", async () => {
    mockCase(null);
    expect(await exportSupportEvidenceBundle(CASE_ID, context)).toBeNull();
    expect(await exportSupportEvidenceBundle("not-an-id", context)).toBeNull();
  });

  it("scopes purchases to the linked purchase when the case has one", async () => {
    const purchaseId = "65f300000000000000000001";
    mockCase(caseRow({ purchaseId }));
    const find = mockPurchases([purchaseRow(1)]);

    await exportBundle();
    expect(find).toHaveBeenCalledWith({ _id: purchaseId });
  });

  it("caps purchases and flags truncation", async () => {
    mockPurchases(Array.from({ length: EVIDENCE_PURCHASE_LIMIT + 5 }, (_, i) => purchaseRow(i)));
    const bundle = await exportBundle();

    expect(bundle.purchases).toHaveLength(EVIDENCE_PURCHASE_LIMIT);
    expect(bundle.purchasesTruncated).toBe(true);
  });
});
