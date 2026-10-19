/**
 * Time-bounded maintainer / support access (#support-access).
 *
 * Support sessions are scoped, expire automatically, notify the affected user
 * with a mandatory (preference-proof) notice, and record every lifecycle
 * transition in the tamper-evident audit trail:
 *
 *   issue   → audit `support_access_granted`  + mandatory `support_access_notice`
 *   use     → audit `support_access_used` / `support_access_denied` (middleware)
 *   revoke  → audit `support_access_revoked`  + mandatory `support_access_notice`
 *
 * The decision logic (`evaluateSupportGrant`, `validateSupportGrantRequest`,
 * `buildSupportAccessNotice`) is pure and covered by unit tests; the IO
 * helpers persist and delegate to it.
 */

import { randomUUID } from "crypto";
import SupportAccessGrant, {
  SUPPORT_ACCESS_SCOPES,
  type SupportAccessScope,
} from "../models/SupportAccessGrant";
import { recordAuditEvent } from "./auditTrail";
import { deliverNotification } from "./notificationRouting";

export const DEFAULT_SUPPORT_GRANT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_SUPPORT_GRANT_TTL_MS = 24 * 60 * 60 * 1000; // hard ceiling: 24 hours
export const DEFAULT_SUPPORT_GRANT_MAX_USES = 25;
export const MAX_SUPPORT_GRANT_USES = 1000;
export const MIN_SUPPORT_REASON_LENGTH = 8;

export type SupportDenialCode =
  | "not_found"
  | "revoked"
  | "expired"
  | "actor_mismatch"
  | "scope_not_granted"
  | "use_limit_reached";

export type SupportGrantDecision =
  | { ok: true; grant: SupportGrantRecord }
  | { ok: false; code: SupportDenialCode; message: string };

export type SupportAccessErrorCode =
  | "invalid_actor"
  | "invalid_target_wallet"
  | "invalid_scopes"
  | "invalid_reason"
  | "invalid_ttl"
  | "invalid_max_uses";

export class SupportAccessError extends Error {
  constructor(
    public readonly code: SupportAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SupportAccessError";
  }
}

export interface SupportGrantRecord {
  grantId: string;
  actor: string;
  targetWallet: string;
  scopes: string[];
  reason: string;
  issuedAt: Date;
  expiresAt: Date;
  maxUses: number;
  uses: number;
  revokedAt: Date | null;
  lastUsedAt?: Date | null;
}

/**
 * Pure grant evaluation used by the middleware on every request. Order
 * matters: revocation and expiry are checked before any actor/scope match so
 * an expired grant cannot be kept alive by caller confusion, and the use
 * budget is enforced before scopes are handed out.
 */
export function evaluateSupportGrant(
  grant: SupportGrantRecord | null | undefined,
  context: { actor: string; scope: string; now: Date },
): SupportGrantDecision {
  if (!grant || !grant.grantId) {
    return {
      ok: false,
      code: "not_found",
      message: "Support grant not found.",
    };
  }
  if (grant.revokedAt) {
    return {
      ok: false,
      code: "revoked",
      message: "Support grant has been revoked.",
    };
  }
  if (
    !(grant.expiresAt instanceof Date) ||
    context.now.getTime() >= grant.expiresAt.getTime()
  ) {
    return {
      ok: false,
      code: "expired",
      message: "Support grant has expired.",
    };
  }
  if (context.actor !== grant.actor) {
    return {
      ok: false,
      code: "actor_mismatch",
      message: "Support grant belongs to a different operator.",
    };
  }
  if (grant.uses >= grant.maxUses) {
    return {
      ok: false,
      code: "use_limit_reached",
      message: "Support grant use budget exhausted.",
    };
  }
  if (!Array.isArray(grant.scopes) || !grant.scopes.includes(context.scope)) {
    return {
      ok: false,
      code: "scope_not_granted",
      message: "Support grant does not carry the required scope.",
    };
  }
  return { ok: true, grant };
}

export interface SupportGrantRequest {
  actor: string;
  targetWallet: string;
  scopes: string[];
  reason: string;
  ttlMs?: number;
  maxUses?: number;
}

export interface ValidatedSupportGrantRequest {
  actor: string;
  targetWallet: string;
  scopes: SupportAccessScope[];
  reason: string;
  ttlMs: number;
  maxUses: number;
}

/**
 * Validate an issuance request before any state is created. Unknown scopes,
 * empty/duplicate scope lists, missing justification, and TTLs beyond
 * {@link MAX_SUPPORT_GRANT_TTL_MS} are rejected — there is no way to request
 * an unbounded session.
 */
export function validateSupportGrantRequest(
  request: SupportGrantRequest,
): ValidatedSupportGrantRequest {
  const actor = request.actor?.trim();
  if (!actor) {
    throw new SupportAccessError("invalid_actor", "actor is required.");
  }

  const targetWallet = request.targetWallet?.trim().toLowerCase();
  if (!targetWallet) {
    throw new SupportAccessError(
      "invalid_target_wallet",
      "targetWallet is required.",
    );
  }

  const scopes = Array.from(new Set(request.scopes ?? []));
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) => !(SUPPORT_ACCESS_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    throw new SupportAccessError(
      "invalid_scopes",
      `scopes must be a non-empty subset of: ${SUPPORT_ACCESS_SCOPES.join(", ")}`,
    );
  }

  const reason = request.reason?.trim();
  if (!reason || reason.length < MIN_SUPPORT_REASON_LENGTH) {
    throw new SupportAccessError(
      "invalid_reason",
      `reason must be at least ${MIN_SUPPORT_REASON_LENGTH} characters (ticket reference recommended).`,
    );
  }

  const ttlMs = request.ttlMs ?? DEFAULT_SUPPORT_GRANT_TTL_MS;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_SUPPORT_GRANT_TTL_MS
  ) {
    throw new SupportAccessError(
      "invalid_ttl",
      `ttlMs must be between 1 and ${MAX_SUPPORT_GRANT_TTL_MS} (24h).`,
    );
  }

  const maxUses = request.maxUses ?? DEFAULT_SUPPORT_GRANT_MAX_USES;
  if (
    !Number.isInteger(maxUses) ||
    maxUses < 1 ||
    maxUses > MAX_SUPPORT_GRANT_USES
  ) {
    throw new SupportAccessError(
      "invalid_max_uses",
      `maxUses must be an integer between 1 and ${MAX_SUPPORT_GRANT_USES}.`,
    );
  }

  return {
    actor,
    targetWallet,
    scopes: scopes as SupportAccessScope[],
    reason,
    ttlMs,
    maxUses,
  };
}

export type SupportNoticeKind = "issued" | "revoked";

/**
 * User-safe notice body. Intentionally excludes the operator identity,
 * internal audit identifiers, and the underlying investigation reason while
 * still giving the user the durable grant id, scope summary, and expiry they
 * need to dispute the access.
 */
export function buildSupportAccessNotice(
  grant: Pick<
    SupportGrantRecord,
    "grantId" | "targetWallet" | "scopes" | "expiresAt"
  >,
  kind: SupportNoticeKind,
): { message: string; dedupeKey: string } {
  const shortId = grant.grantId.slice(0, 18);
  const scopeSummary = grant.scopes.join(", ");
  const message =
    kind === "issued"
      ? `A PromptHash support session (${shortId}) was opened for your account. Scope: ${scopeSummary}. It expires automatically at ${grant.expiresAt.toISOString()}. You can request an audit of this session at any time from account security settings.`
      : `The PromptHash support session (${shortId}) on your account has ended. Scope: ${scopeSummary}. You can request a full audit of what was accessed at any time from account security settings.`;

  return { message, dedupeKey: `support_access:${grant.grantId}:${kind}` };
}

export interface IssueSupportGrantResult {
  grantId: string;
  actor: string;
  targetWallet: string;
  scopes: string[];
  issuedAt: Date;
  expiresAt: Date;
  maxUses: number;
  noticeNotificationId?: string;
}

/**
 * Create a time-bounded support grant, deliver the mandatory user notice, and
 * audit the issuance. IO-touching; pure validation lives above.
 */
export async function issueSupportGrant(
  request: SupportGrantRequest,
  context: { now?: Date; requestId?: string | null } = {},
): Promise<IssueSupportGrantResult> {
  const validated = validateSupportGrantRequest(request);
  const now = context.now ?? new Date();
  const expiresAt = new Date(now.getTime() + validated.ttlMs);
  const grantId = `sag_${randomUUID()}`;

  await SupportAccessGrant.create({
    grantId,
    actor: validated.actor,
    targetWallet: validated.targetWallet,
    scopes: validated.scopes,
    reason: validated.reason,
    issuedAt: now,
    expiresAt,
    maxUses: validated.maxUses,
    uses: 0,
  });

  // Mandatory notice: routed by policy, never muted by preferences.
  const notice = buildSupportAccessNotice(
    {
      grantId,
      targetWallet: validated.targetWallet,
      scopes: validated.scopes,
      expiresAt,
    },
    "issued",
  );
  let noticeNotificationId: string | undefined;
  try {
    const receipt = await deliverNotification({
      recipientWallet: validated.targetWallet,
      type: "support_access_notice",
      message: notice.message,
      dedupeKey: notice.dedupeKey,
      requestId: context.requestId ?? null,
    });
    noticeNotificationId = receipt.notificationId;
  } catch (err) {
    // Notice delivery must not roll back the grant; the audit trail still
    // records issuance, and ops can replay the notice by grantId.
    console.error(
      `[support-access] failed to deliver notice for ${grantId}:`,
      err,
    );
  }

  await recordAuditEvent({
    action: "support_access_granted",
    result: "success",
    promptId: null,
    walletAddress: validated.targetWallet,
    requestId: context.requestId ?? null,
    reason: `grantId=${grantId} actor=${validated.actor} scopes=${validated.scopes.join(",")} expiresAt=${expiresAt.toISOString()} ttlMs=${validated.ttlMs} maxUses=${validated.maxUses}`,
  });

  return {
    grantId,
    actor: validated.actor,
    targetWallet: validated.targetWallet,
    scopes: validated.scopes,
    issuedAt: now,
    expiresAt,
    maxUses: validated.maxUses,
    noticeNotificationId,
  };
}

export async function findSupportAccessGrant(
  grantId: string,
): Promise<SupportGrantRecord | null> {
  if (!grantId) return null;
  return (await SupportAccessGrant.findOne({
    grantId,
  }).lean()) as SupportGrantRecord | null;
}

/**
 * Atomically consume one use from the grant budget. Returns the updated grant
 * or null when the grant was revoked/expired/exhausted between evaluation and
 * this call — the middleware treats null as a denied request, which keeps
 * expiry truthful even under concurrent requests.
 */
export async function markSupportAccessUsed(
  grantId: string,
  now: Date,
): Promise<SupportGrantRecord | null> {
  const updated = await SupportAccessGrant.findOneAndUpdate(
    {
      grantId,
      revokedAt: null,
      expiresAt: { $gt: now },
      $expr: { $lt: ["$uses", "$maxUses"] },
    },
    { $inc: { uses: 1 }, $set: { lastUsedAt: now } },
    { new: true },
  ).lean();
  return (updated as SupportGrantRecord | null) ?? null;
}

export interface RevokeSupportGrantResult {
  revoked: boolean;
  grantId: string;
  noticeNotificationId?: string;
}

/**
 * Revoke a grant early. Revocation is idempotent: revoking an already-revoked
 * or unknown grant returns `revoked: false` without creating a second notice.
 */
export async function revokeSupportGrant(
  grantId: string,
  context: { actor: string; requestId?: string | null; now?: Date },
): Promise<RevokeSupportGrantResult> {
  const now = context.now ?? new Date();
  const grant = (await SupportAccessGrant.findOne({
    grantId,
  }).lean()) as SupportGrantRecord | null;
  if (!grant || grant.revokedAt) {
    return { revoked: false, grantId };
  }

  await SupportAccessGrant.findOneAndUpdate(
    { grantId, revokedAt: null },
    { $set: { revokedAt: now, revokedBy: context.actor } },
  );

  let noticeNotificationId: string | undefined;
  try {
    const notice = buildSupportAccessNotice(grant, "revoked");
    const receipt = await deliverNotification({
      recipientWallet: grant.targetWallet,
      type: "support_access_notice",
      message: notice.message,
      dedupeKey: notice.dedupeKey,
      requestId: context.requestId ?? null,
    });
    noticeNotificationId = receipt.notificationId;
  } catch (err) {
    console.error(
      `[support-access] failed to deliver revocation notice for ${grantId}:`,
      err,
    );
  }

  await recordAuditEvent({
    action: "support_access_revoked",
    result: "success",
    promptId: null,
    walletAddress: grant.targetWallet,
    requestId: context.requestId ?? null,
    reason: `grantId=${grantId} revokedBy=${context.actor}`,
  });

  return { revoked: true, grantId, noticeNotificationId };
}

export interface SupportGrantSummary {
  grantId: string;
  actor: string;
  targetWallet: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  active: boolean;
}

export function summarizeSupportGrant(
  grant: SupportGrantRecord,
  now = new Date(),
): SupportGrantSummary {
  return {
    grantId: grant.grantId,
    actor: grant.actor,
    targetWallet: grant.targetWallet,
    scopes: grant.scopes,
    issuedAt: new Date(grant.issuedAt).toISOString(),
    expiresAt: new Date(grant.expiresAt).toISOString(),
    maxUses: grant.maxUses,
    uses: grant.uses,
    revokedAt: grant.revokedAt ? new Date(grant.revokedAt).toISOString() : null,
    active:
      !grant.revokedAt && new Date(grant.expiresAt).getTime() > now.getTime(),
  };
}

export async function listSupportAccessGrants(
  filter: {
    actor?: string;
    targetWallet?: string;
    activeOnly?: boolean;
    limit?: number;
    now?: Date;
  } = {},
): Promise<SupportGrantSummary[]> {
  const now = filter.now ?? new Date();
  const query: Record<string, unknown> = {};
  if (filter.actor) query.actor = filter.actor;
  if (filter.targetWallet)
    query.targetWallet = filter.targetWallet.toLowerCase();
  if (filter.activeOnly) {
    query.revokedAt = null;
    query.expiresAt = { $gt: now };
  }
  const grants = (await SupportAccessGrant.find(query)
    .sort({ issuedAt: -1 })
    .limit(Math.min(filter.limit ?? 50, 200))
    .lean()) as unknown as SupportGrantRecord[];
  return grants.map((grant) => summarizeSupportGrant(grant, now));
}

export { SUPPORT_ACCESS_SCOPES };
export type { SupportAccessScope };
