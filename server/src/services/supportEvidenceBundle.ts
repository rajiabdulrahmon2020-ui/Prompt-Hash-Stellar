import { createHash } from "crypto";
import mongoose from "mongoose";
import SupportCase from "../models/SupportCase.js";
import Purchase from "../models/Purchase.js";
import { AuditLog } from "../models/AuditLog.js";
import {
  canonicalJson,
  computeRecordHash,
  exportAuditBundle,
  hashInputFromRow,
  hashWalletAddress,
  recordAuditEvent,
  verifyAuditExport,
  type AuditBundle,
  type AuditExportVerification,
} from "./auditTrail.js";

/**
 * Privacy-preserving evidence bundles for support investigations (#967).
 *
 * A bundle captures everything needed to verify what happened on a support
 * case without carrying secrets or PII:
 *   - identifiers, statuses, and timestamps are kept as-is;
 *   - wallet addresses become the same SHA-256 hash the audit trail stores,
 *     so they correlate with audit records without being disclosed;
 *   - free text (title, description, notes, resolution note) and evidence
 *     URLs become a SHA-256 digest plus length: anyone holding the original
 *     can prove it matches, nobody else can read it;
 *   - Stellar transaction hashes are kept, since they are public on-ledger
 *     settlement proofs;
 *   - client IPs, audit metadata, and before/after states are never included.
 *
 * The bundle's manifest checksum is written to the hash-chained audit trail at
 * export time. Verification therefore detects edits even by someone who
 * recomputes the checksum, because the anchor record cannot be rewritten.
 */

export const EVIDENCE_BUNDLE_VERSION = 1;
export const EVIDENCE_AUDIT_RECORD_LIMIT = 1_000;
export const EVIDENCE_PURCHASE_LIMIT = 50;
export const EVIDENCE_TARGET_TYPE = "support_evidence_bundle";

export interface TextDigest {
  sha256: string;
  length: number;
}

export interface EvidenceNote {
  authorHash: string;
  isPrivate: boolean;
  createdAt: string;
  text: TextDigest;
}

export interface EvidenceCase {
  caseId: string;
  type: string;
  status: string;
  resolution: string | null;
  promptId: string;
  purchaseId: string | null;
  buyerWalletHash: string;
  creatorWalletHash: string | null;
  assignedToHash: string | null;
  title: TextDigest;
  description: TextDigest;
  resolutionNote: TextDigest | null;
  notes: EvidenceNote[];
  evidenceUrls: TextDigest[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface EvidencePurchase {
  purchaseId: string;
  promptId: string;
  buyerWalletHash: string;
  txHash: string | null;
  status: string;
  disputeResolution: string | null;
  versionIndex: number;
  licenseVersionIndex: number;
  licenseSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportEvidenceBundle {
  bundleVersion: number;
  generatedAt: string;
  case: EvidenceCase;
  purchases: EvidencePurchase[];
  purchasesTruncated: boolean;
  audit: AuditBundle;
  manifestChecksum: string;
}

export interface EvidenceBundleVerification {
  valid: boolean;
  manifestValid: boolean;
  anchored: boolean;
  audit: AuditExportVerification;
  errors: string[];
}

/** Raised when the export could not be anchored; no bundle is released. */
export class EvidenceAnchorError extends Error {
  constructor(cause: unknown) {
    super("Evidence bundle could not be anchored in the audit trail.", { cause });
    this.name = "EvidenceAnchorError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(text: string): TextDigest {
  return { sha256: sha256(text), length: text.length };
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value?: Date | string | null): string | null => (value ? iso(value) : null);
const hashOrNull = (value?: string | null): string | null => (value ? hashWalletAddress(value) : null);

function toEvidenceCase(row: any): EvidenceCase {
  return {
    caseId: String(row._id),
    type: row.type,
    status: row.status,
    resolution: row.resolution ?? null,
    promptId: row.promptId,
    purchaseId: row.purchaseId ? String(row.purchaseId) : null,
    buyerWalletHash: hashWalletAddress(row.buyerWallet),
    creatorWalletHash: hashOrNull(row.creatorWallet),
    assignedToHash: hashOrNull(row.assignedTo),
    title: digest(row.title),
    description: digest(row.description),
    resolutionNote: row.resolutionNote ? digest(row.resolutionNote) : null,
    notes: (row.notes ?? []).map((note: any) => ({
      authorHash: hashWalletAddress(note.author),
      isPrivate: Boolean(note.isPrivate),
      createdAt: iso(note.createdAt),
      text: digest(note.text),
    })),
    evidenceUrls: (row.evidenceUrls ?? []).map(digest),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    resolvedAt: isoOrNull(row.resolvedAt),
  };
}

function toEvidencePurchase(row: any): EvidencePurchase {
  return {
    purchaseId: String(row._id),
    promptId: row.promptId,
    buyerWalletHash: hashWalletAddress(row.buyerWallet),
    txHash: row.txHash || null,
    status: row.status,
    disputeResolution: row.disputeResolution ?? null,
    versionIndex: row.versionIndex,
    licenseVersionIndex: row.licenseVersionIndex ?? 1,
    licenseSnapshotId: row.licenseSnapshotId ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * SHA-256 over the canonical JSON of the bundle's content fields. Fields are
 * picked explicitly so anything added to a bundle in transit is ignored and
 * anything changed is detected.
 */
export function manifestChecksumOf(bundle: Omit<SupportEvidenceBundle, "manifestChecksum">): string {
  return sha256(
    canonicalJson({
      bundleVersion: bundle.bundleVersion,
      generatedAt: bundle.generatedAt,
      case: bundle.case,
      purchases: bundle.purchases,
      purchasesTruncated: bundle.purchasesTruncated,
      audit: bundle.audit,
    }),
  );
}

/** The audit `reason` recorded for an export; hashed into the audit chain. */
function anchorReason(manifestChecksum: string, recordCount: number): string {
  return `manifest=${manifestChecksum} records=${recordCount}`;
}

/**
 * Build, anchor, and return the evidence bundle for a support case, or `null`
 * when the case does not exist.
 *
 * Time O(n + p + a) and space O(n + p + a) for n notes/URLs, p ≤ 50 purchases
 * and a ≤ 1,000 audit records; every query is served by an existing index
 * (`_id`, `{promptId, buyerWallet}`, and the audit export indexes).
 */
export async function exportSupportEvidenceBundle(
  caseId: string,
  context: { actor: string | null; requestId: string | null },
): Promise<SupportEvidenceBundle | null> {
  if (!mongoose.isValidObjectId(caseId)) return null;
  const caseRow: any = await SupportCase.findById(caseId).lean();
  if (!caseRow) return null;

  const purchaseQuery = caseRow.purchaseId
    ? { _id: caseRow.purchaseId }
    : { promptId: caseRow.promptId, buyerWallet: caseRow.buyerWallet };

  const [purchaseRows, audit] = await Promise.all([
    Purchase.find(purchaseQuery)
      .sort({ createdAt: 1 })
      .limit(EVIDENCE_PURCHASE_LIMIT + 1)
      .lean(),
    // Buyer events on this prompt only: the actor filter matches the stored
    // wallet hash, so the raw address never reaches the export.
    exportAuditBundle({
      actor: caseRow.buyerWallet,
      promptId: caseRow.promptId,
      limit: EVIDENCE_AUDIT_RECORD_LIMIT,
    }),
  ]);

  const content = {
    bundleVersion: EVIDENCE_BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    case: toEvidenceCase(caseRow),
    purchases: (purchaseRows as any[]).slice(0, EVIDENCE_PURCHASE_LIMIT).map(toEvidencePurchase),
    purchasesTruncated: purchaseRows.length > EVIDENCE_PURCHASE_LIMIT,
    audit,
  };
  const manifestChecksum = manifestChecksumOf(content);

  try {
    await recordAuditEvent(
      {
        action: "audit_export",
        result: "success",
        actor: context.actor,
        promptId: caseRow.promptId,
        target: content.case.caseId,
        targetType: EVIDENCE_TARGET_TYPE,
        requestId: context.requestId,
        reason: anchorReason(manifestChecksum, audit.recordCount),
      },
      { throwOnError: true },
    );
  } catch (err) {
    throw new EvidenceAnchorError(err);
  }

  return { ...content, manifestChecksum };
}

/**
 * Verify a bundle:
 *  1. its manifest checksum matches its content,
 *  2. that checksum was anchored at export time by an audit record that
 *     still passes its own integrity hash, and
 *  3. every embedded audit record matches the stored, hash-chained record.
 */
export async function verifySupportEvidenceBundle(
  bundle: SupportEvidenceBundle,
): Promise<EvidenceBundleVerification> {
  const errors: string[] = [];

  const manifestValid = manifestChecksumOf(bundle) === bundle.manifestChecksum;
  if (!manifestValid) {
    errors.push("Manifest checksum mismatch: the bundle content was modified.");
  }

  const anchor: any = await AuditLog.findOne({
    action: "audit_export",
    target: bundle.case?.caseId,
    targetType: EVIDENCE_TARGET_TYPE,
    reason: anchorReason(bundle.manifestChecksum, bundle.audit?.recordCount),
  }).lean();
  const anchored = Boolean(anchor) && computeRecordHash(hashInputFromRow(anchor)) === anchor.recordHash;
  if (!anchored) {
    errors.push("No intact audit record anchors this manifest checksum: the bundle was not issued by this system or was altered.");
  }

  const audit = await verifyAuditExport(bundle.audit ?? {});
  errors.push(...audit.errors);

  return {
    valid: errors.length === 0,
    manifestValid,
    anchored,
    audit,
    errors,
  };
}
