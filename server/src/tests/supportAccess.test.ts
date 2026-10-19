import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response } from "express";

vi.mock("../services/auditTrail", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
  queryAuditEvents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/notificationRouting", () => ({
  deliverNotification: vi.fn().mockResolvedValue({
    delivered: true,
    alreadyDelivered: false,
    mandatory: true,
    channels: { inApp: true, email: true },
    notificationId: "notice-1",
  }),
}));

vi.mock("../models/SupportAccessGrant", () => ({
  default: {
    create: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
  SUPPORT_ACCESS_SCOPES: [
    "support:read",
    "support:entitlements:read",
    "support:unlock:diagnose",
  ],
}));

import SupportAccessGrant from "../models/SupportAccessGrant";
import { recordAuditEvent } from "../services/auditTrail";
import { deliverNotification } from "../services/notificationRouting";
import {
  SupportAccessError,
  buildSupportAccessNotice,
  evaluateSupportGrant,
  issueSupportGrant,
  revokeSupportGrant,
  summarizeSupportGrant,
  validateSupportGrantRequest,
  type SupportGrantRecord,
} from "../services/supportAccess";
import {
  requireSupportAccess,
  type SupportAccessRequest,
} from "../middleware/supportAccess";

const NOW = new Date("2026-02-01T12:00:00.000Z");

function makeGrant(
  overrides: Partial<SupportGrantRecord> = {},
): SupportGrantRecord {
  return {
    grantId: "sag_test-1",
    actor: "ops-jane",
    targetWallet: "guser",
    scopes: ["support:entitlements:read"],
    reason: "ticket SUP-1042",
    issuedAt: new Date("2026-02-01T10:00:00.000Z"),
    // Middleware tests exercise the real clock, so the default grant must be
    // live relative to "now" as well as relative to the frozen NOW above.
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    maxUses: 5,
    uses: 0,
    revokedAt: null,
    ...overrides,
  };
}

describe("evaluateSupportGrant (pure)", () => {
  it("allows a live grant for the matching actor and scope", () => {
    const decision = evaluateSupportGrant(makeGrant(), {
      actor: "ops-jane",
      scope: "support:entitlements:read",
      now: NOW,
    });
    expect(decision.ok).toBe(true);
  });

  it("expires exactly at expiresAt (boundary is inclusive)", () => {
    const grant = makeGrant();
    const justBefore = evaluateSupportGrant(grant, {
      actor: "ops-jane",
      scope: "support:entitlements:read",
      now: new Date(grant.expiresAt.getTime() - 1),
    });
    const atBoundary = evaluateSupportGrant(grant, {
      actor: "ops-jane",
      scope: "support:entitlements:read",
      now: grant.expiresAt,
    });

    expect(justBefore.ok).toBe(true);
    expect(atBoundary.ok).toBe(false);
    expect((atBoundary as { code: string }).code).toBe("expired");
  });

  it("denies a revoked grant", () => {
    const decision = evaluateSupportGrant(
      makeGrant({ revokedAt: new Date() }),
      {
        actor: "ops-jane",
        scope: "support:entitlements:read",
        now: NOW,
      },
    );
    expect(decision.ok).toBe(false);
    expect((decision as { code: string }).code).toBe("revoked");
  });

  it("denies a different admin operator using someone else's grant", () => {
    const decision = evaluateSupportGrant(makeGrant(), {
      actor: "ops-mallory",
      scope: "support:entitlements:read",
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    expect((decision as { code: string }).code).toBe("actor_mismatch");
  });

  it("denies scope escalation beyond the granted scopes", () => {
    const decision = evaluateSupportGrant(makeGrant(), {
      actor: "ops-jane",
      scope: "support:unlock:diagnose",
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    expect((decision as { code: string }).code).toBe("scope_not_granted");
  });

  it("denies use once the budget is exhausted", () => {
    const decision = evaluateSupportGrant(makeGrant({ uses: 5, maxUses: 5 }), {
      actor: "ops-jane",
      scope: "support:entitlements:read",
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    expect((decision as { code: string }).code).toBe("use_limit_reached");
  });

  it("denies a missing grant", () => {
    const decision = evaluateSupportGrant(null, {
      actor: "ops-jane",
      scope: "support:entitlements:read",
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    expect((decision as { code: string }).code).toBe("not_found");
  });
});

describe("validateSupportGrantRequest (pure)", () => {
  const validRequest = {
    actor: "ops-jane",
    targetWallet: "GUSER",
    scopes: ["support:entitlements:read"],
    reason: "ticket SUP-1042",
  };

  it("normalizes wallet and accepts the default TTL/budget", () => {
    const validated = validateSupportGrantRequest(validRequest);
    expect(validated.targetWallet).toBe("guser");
    expect(validated.ttlMs).toBeGreaterThan(0);
    expect(validated.maxUses).toBeGreaterThan(0);
  });

  it("rejects unknown scopes", () => {
    expect(() =>
      validateSupportGrantRequest({ ...validRequest, scopes: ["admin:*"] }),
    ).toThrow(SupportAccessError);
  });

  it("rejects TTLs beyond the 24h ceiling and non-positive TTLs", () => {
    expect(() =>
      validateSupportGrantRequest({
        ...validRequest,
        ttlMs: 25 * 60 * 60 * 1000,
      }),
    ).toThrow(/ttlMs/i);
    expect(() =>
      validateSupportGrantRequest({ ...validRequest, ttlMs: 0 }),
    ).toThrow(/ttlMs/i);
  });

  it("requires a justification of meaningful length", () => {
    expect(() =>
      validateSupportGrantRequest({ ...validRequest, reason: "why" }),
    ).toThrow(/reason/i);
  });
});

describe("buildSupportAccessNotice (pure)", () => {
  it("produces a user-safe notice without internal identifiers or the operator name", () => {
    const grant = makeGrant();
    const notice = buildSupportAccessNotice(grant, "issued");

    expect(notice.message).toContain("sag_test-1".slice(0, 18));
    expect(notice.message).toContain(grant.expiresAt.toISOString());
    expect(notice.message).not.toContain("ops-jane");
    expect(notice.message).not.toContain("ticket");
    expect(notice.dedupeKey).toBe("support_access:sag_test-1:issued");
  });
});

describe("support access lifecycle (service)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a grant, delivers the mandatory user notice, and audits issuance", async () => {
    (SupportAccessGrant.create as any).mockResolvedValue({});

    const result = await issueSupportGrant(
      {
        actor: "ops-jane",
        targetWallet: "GUSER",
        scopes: ["support:entitlements:read"],
        reason: "ticket SUP-1042",
        ttlMs: 60 * 60 * 1000,
      },
      { now: NOW, requestId: "req-1" },
    );

    expect(result.grantId).toMatch(/^sag_/);
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);
    expect(SupportAccessGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "ops-jane",
        targetWallet: "guser",
        scopes: ["support:entitlements:read"],
        uses: 0,
      }),
    );
    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientWallet: "guser",
        type: "support_access_notice",
        dedupeKey: expect.stringContaining(":issued"),
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support_access_granted",
        result: "success",
        walletAddress: "guser",
      }),
    );
  });

  it("still records the grant when the user notice fails to deliver", async () => {
    (SupportAccessGrant.create as any).mockResolvedValue({});
    (deliverNotification as any).mockRejectedValueOnce(
      new Error("notification db down"),
    );

    const result = await issueSupportGrant(
      {
        actor: "ops-jane",
        targetWallet: "GUSER",
        scopes: ["support:read"],
        reason: "ticket SUP-1043",
      },
      { now: NOW },
    );

    expect(result.grantId).toMatch(/^sag_/);
    expect(result.noticeNotificationId).toBeUndefined();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "support_access_granted" }),
    );
  });

  it("rejects an invalid request before creating any state", async () => {
    await expect(
      issueSupportGrant({
        actor: "",
        targetWallet: "GUSER",
        scopes: ["support:read"],
        reason: "ticket SUP-1",
      }),
    ).rejects.toThrow(SupportAccessError);
    expect(SupportAccessGrant.create).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("revokes a live grant once, notifying and auditing; a second revoke is a no-op", async () => {
    (SupportAccessGrant.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(makeGrant()),
    });
    (SupportAccessGrant.findOneAndUpdate as any).mockResolvedValue({});

    const first = await revokeSupportGrant("sag_test-1", {
      actor: "ops-lead",
      now: NOW,
    });
    expect(first.revoked).toBe(true);
    expect(deliverNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "support_access:sag_test-1:revoked",
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "support_access_revoked" }),
    );

    vi.clearAllMocks();
    (SupportAccessGrant.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(makeGrant({ revokedAt: NOW })),
    });
    const second = await revokeSupportGrant("sag_test-1", {
      actor: "ops-lead",
      now: NOW,
    });
    expect(second.revoked).toBe(false);
    expect(deliverNotification).not.toHaveBeenCalled();
  });
});

describe("summarizeSupportGrant (pure)", () => {
  it("marks revoked and expired grants inactive without exposing the reason", () => {
    const active = summarizeSupportGrant(makeGrant(), NOW);
    const expired = summarizeSupportGrant(makeGrant({ expiresAt: NOW }), NOW);
    const revoked = summarizeSupportGrant(makeGrant({ revokedAt: NOW }), NOW);

    expect(active.active).toBe(true);
    expect(expired.active).toBe(false);
    expect(revoked.active).toBe(false);
    expect(JSON.stringify(revoked)).not.toContain("ticket SUP");
  });
});

describe("requireSupportAccess middleware", () => {
  function makeReq(
    overrides: Partial<SupportAccessRequest> = {},
  ): SupportAccessRequest {
    return {
      headers: {},
      method: "GET",
      baseUrl: "/api/admin/support-access",
      path: "/sessions/guser/entitlements",
      socket: { remoteAddress: "127.0.0.1" },
      correlationId: "req-42",
      ...overrides,
    } as unknown as SupportAccessRequest;
  }

  function makeRes(): Response {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res as Response;
  }

  const admin = { sub: "ops-jane" } as SupportAccessRequest["admin"];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed when mounted without admin authentication", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    await requireSupportAccess("support:entitlements:read")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support_access_denied",
        result: "blocked",
      }),
    );
  });

  it("rejects a request without the grant header and audits the denial", async () => {
    const req = makeReq({ admin });
    const res = makeRes();
    const next = vi.fn();

    await requireSupportAccess("support:entitlements:read")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support_access_denied",
        reason: expect.stringContaining("missing_grant_header"),
      }),
    );
  });

  it("denies an expired grant without consuming a use", async () => {
    (SupportAccessGrant.findOne as any).mockReturnValue({
      lean: vi
        .fn()
        .mockResolvedValue(
          makeGrant({ expiresAt: new Date(Date.now() - 1000) }),
        ),
    });
    const req = makeReq({
      admin,
      headers: { "x-support-grant-id": "sag_test-1" },
    });
    const res = makeRes();
    const next = vi.fn();

    await requireSupportAccess("support:entitlements:read")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(SupportAccessGrant.findOneAndUpdate).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support_access_denied",
        reason: expect.stringContaining("expired"),
      }),
    );
  });

  it("admits a valid request, consumes a use atomically, and audits the access", async () => {
    const grant = makeGrant();
    (SupportAccessGrant.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(grant),
    });
    (SupportAccessGrant.findOneAndUpdate as any).mockReturnValue({
      lean: vi
        .fn()
        .mockResolvedValue({ ...grant, uses: 1, lastUsedAt: new Date() }),
    });
    const req = makeReq({
      admin,
      headers: { "x-support-grant-id": "sag_test-1" },
    });
    const res = makeRes();
    const next = vi.fn();

    await requireSupportAccess("support:entitlements:read")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.supportAccess).toMatchObject({
      grantId: "sag_test-1",
      targetWallet: "guser",
    });
    expect(SupportAccessGrant.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "sag_test-1",
        revokedAt: null,
        expiresAt: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({ $inc: { uses: 1 } }),
      expect.anything(),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support_access_used",
        result: "success",
        walletAddress: "guser",
        reason: expect.stringContaining("uses=1/5"),
      }),
    );
  });

  it("denies when the atomic use-consumption loses a race (grant vanished/expired mid-request)", async () => {
    const grant = makeGrant();
    (SupportAccessGrant.findOne as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(grant),
    });
    (SupportAccessGrant.findOneAndUpdate as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    const req = makeReq({
      admin,
      headers: { "x-support-grant-id": "sag_test-1" },
    });
    const res = makeRes();
    const next = vi.fn();

    await requireSupportAccess("support:entitlements:read")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "support_access_denied",
        reason: expect.stringContaining("use_conflict"),
      }),
    );
  });
});

describe("support access route inventory", () => {
  it("guards every support-access route with admin auth, and the session route with a grant", async () => {
    process.env.MONGODB_URI ||=
      "mongodb://127.0.0.1:27017/prompt-hash-stellar-test";
    const { supportAccessRouter } =
      await import("../routes/supportAccessRoutes.js");

    const adminGuarded: Array<{ method: string; path: string }> = [
      { method: "post", path: "/grants" },
      { method: "get", path: "/grants" },
      { method: "get", path: "/grants/:grantId" },
      { method: "post", path: "/grants/:grantId/revoke" },
      { method: "get", path: "/audit" },
      { method: "get", path: "/sessions/:targetWallet/entitlements" },
    ];

    for (const { method, path } of adminGuarded) {
      const layer = (supportAccessRouter as any).stack.find(
        (entry: any) =>
          entry.route?.path === path && entry.route.methods[method],
      );
      expect(
        layer,
        `route ${method.toUpperCase()} ${path} should be registered`,
      ).toBeTruthy();
      const handlerNames = layer.route.stack.map((s: any) => s.name);
      expect(
        handlerNames,
        `route ${method.toUpperCase()} ${path} is missing the admin auth guard`,
      ).toContain("adminAuthMiddleware");
    }

    const sessionLayer = (supportAccessRouter as any).stack.find(
      (entry: any) =>
        entry.route?.path === "/sessions/:targetWallet/entitlements" &&
        entry.route.methods.get,
    );
    const sessionHandlers = sessionLayer.route.stack.map((s: any) => s.name);
    expect(sessionHandlers).toContain("supportAccessMiddleware");
    // The support-access guard must run *after* admin auth so `req.admin`
    // exists; index order proves composition.
    expect(sessionHandlers.indexOf("supportAccessMiddleware")).toBeGreaterThan(
      sessionHandlers.indexOf("adminAuthMiddleware"),
    );
  }, 20_000);
});
