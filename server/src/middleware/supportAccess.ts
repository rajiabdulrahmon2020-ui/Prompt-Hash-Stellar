/**
 * Support-access guard (#support-access).
 *
 * Mounted *after* `requireAdminScope("support:use")` on routes that act on
 * behalf of a user through a time-bounded grant:
 *
 *   router.get("/sessions/:wallet/…",
 *     requireAdminScope("support:use"),
 *     requireSupportAccess("support:entitlements:read"),
 *     handler);
 *
 * Guarantees:
 *   - fails closed (503) when mounted without admin authentication — it can
 *     never become a bypass;
 *   - the grant id arrives via the `x-support-grant-id` header and must match
 *     the caller's admin `sub`;
 *   - expiry/revocation/scope/use-budget are re-evaluated server-side on
 *     every request through the pure `evaluateSupportGrant`;
 *   - the use budget is consumed atomically, so two concurrent requests can
 *     never exceed `maxUses` or use a grant that expires mid-request;
 *   - every allow and deny writes to the tamper-evident audit trail before
 *     the handler runs, with the target wallet hashed by `recordAuditEvent`.
 */

import { Request, Response, NextFunction } from "express";
import {
  evaluateSupportGrant,
  findSupportAccessGrant,
  markSupportAccessUsed,
  type SupportDenialCode,
} from "../services/supportAccess";
import { recordAuditEvent } from "../services/auditTrail";
import type { AdminTokenPayload } from "../services/adminToken";

export const SUPPORT_GRANT_HEADER = "x-support-grant-id";

export interface SupportAccessRequest extends Request {
  admin?: AdminTokenPayload;
  supportAccess?: {
    grantId: string;
    targetWallet: string;
    scopes: string[];
    expiresAt: Date;
  };
}

function clientIpOf(req: Request): string {
  return String(
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
  );
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function deny(
  req: SupportAccessRequest,
  res: Response,
  reason: string,
  options: {
    status?: number;
    code?:
      | SupportDenialCode
      | "missing_grant"
      | "storage_error"
      | "use_conflict"
      | "admin_context_required";
    walletAddress?: string | null;
  } = {},
): Promise<void> {
  const { status = 403, code, walletAddress = null } = options;
  await recordAuditEvent({
    action: "support_access_denied",
    result: "blocked",
    promptId: null,
    walletAddress,
    requestId: req.correlationId ?? null,
    clientIp: clientIpOf(req),
    reason,
  });
  res.status(status).json({
    error: "Support access denied.",
    ...(code ? { code } : {}),
  });
}

export function requireSupportAccess(requiredScope: string) {
  return async function supportAccessMiddleware(
    req: SupportAccessRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const admin = req.admin;

    if (!admin?.sub) {
      // Fail closed: this guard must be composed with admin auth, never used
      // as a standalone bypass.
      await deny(
        req,
        res,
        `scope=${requiredScope} route=${route} error=no_admin_context`,
        {
          status: 503,
          code: "admin_context_required",
        },
      );
      return;
    }

    const grantId = headerValue(req, SUPPORT_GRANT_HEADER);
    if (!grantId) {
      await deny(
        req,
        res,
        `scope=${requiredScope} route=${route} error=missing_grant_header`,
        {
          status: 400,
          code: "missing_grant",
        },
      );
      return;
    }

    let grant;
    try {
      grant = await findSupportAccessGrant(grantId);
    } catch {
      await deny(
        req,
        res,
        `scope=${requiredScope} route=${route} error=storage_error`,
        {
          status: 503,
          code: "storage_error",
        },
      );
      return;
    }

    const now = new Date();
    const decision = evaluateSupportGrant(grant, {
      actor: admin.sub,
      scope: requiredScope,
      now,
    });

    if (!decision.ok) {
      await deny(
        req,
        res,
        `scope=${requiredScope} route=${route} grant=${grantId} error=${decision.code}`,
        {
          status: decision.code === "not_found" ? 404 : 403,
          code: decision.code,
          walletAddress: grant?.targetWallet ?? null,
        },
      );
      return;
    }

    // Consume the use budget atomically. A null result means the grant was
    // revoked/expired/exhausted between the evaluation above and this write.
    let consumed;
    try {
      consumed = await markSupportAccessUsed(grantId, now);
    } catch {
      await deny(
        req,
        res,
        `scope=${requiredScope} route=${route} grant=${grantId} error=storage_error`,
        {
          status: 503,
          code: "storage_error",
          walletAddress: grant?.targetWallet ?? null,
        },
      );
      return;
    }

    if (!consumed) {
      await deny(
        req,
        res,
        `scope=${requiredScope} route=${route} grant=${grantId} error=use_conflict`,
        {
          status: 403,
          code: "use_conflict",
          walletAddress: grant?.targetWallet ?? null,
        },
      );
      return;
    }

    await recordAuditEvent({
      action: "support_access_used",
      result: "success",
      promptId: null,
      walletAddress: consumed.targetWallet,
      requestId: req.correlationId ?? null,
      clientIp: clientIpOf(req),
      reason: `grantId=${grantId} actor=${admin.sub} scope=${requiredScope} route=${route} uses=${consumed.uses}/${consumed.maxUses}`,
    });

    req.supportAccess = {
      grantId,
      targetWallet: consumed.targetWallet,
      scopes: consumed.scopes,
      expiresAt: consumed.expiresAt,
    };
    next();
  };
}
