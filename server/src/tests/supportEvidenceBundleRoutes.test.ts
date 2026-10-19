import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

const mocks = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  verifyBundle: vi.fn(),
}));

vi.mock("../services/auditTrail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/auditTrail.js")>()),
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/supportEvidenceBundle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/supportEvidenceBundle.js")>()),
  exportSupportEvidenceBundle: mocks.exportBundle,
  verifySupportEvidenceBundle: mocks.verifyBundle,
}));

import { supportCaseRouter } from "../routes/supportCaseRoutes";
import { createAdminToken } from "../services/adminToken";
import { EvidenceAnchorError } from "../services/supportEvidenceBundle.js";

const SECRET = "a-sufficiently-long-admin-secret";
const AUDIENCE = "prompt-hash-admin-test";
const CASE_ID = "65f0000000000000000000aa";

let server: Server;
let baseUrl: string;

function token(scope: string[]) {
  return createAdminToken(SECRET, { sub: "support-admin", scope, iss: "test", aud: AUDIENCE }).token;
}

function call(path: string, init: RequestInit & { scope?: string[] } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.scope) headers.authorization = `Bearer ${token(init.scope)}`;
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

const validBundle = {
  manifestChecksum: "f".repeat(64),
  case: { caseId: CASE_ID },
  audit: { records: [], integrityChecksum: "e".repeat(64) },
};

describe("support evidence bundle routes (#967)", () => {
  beforeAll(async () => {
    process.env.ADMIN_TOKEN_SECRET = SECRET;
    process.env.ADMIN_TOKEN_AUDIENCE = AUDIENCE;
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/api/support-cases", supportCaseRouter);
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    delete process.env.ADMIN_TOKEN_SECRET;
    delete process.env.ADMIN_TOKEN_AUDIENCE;
  });

  beforeEach(() => vi.clearAllMocks());

  it("requires an admin token with the support:read scope", async () => {
    expect((await call(`/api/support-cases/${CASE_ID}/evidence-bundle`)).status).toBe(401);
    const wrongScope = await call(`/api/support-cases/${CASE_ID}/evidence-bundle`, {
      scope: ["support:write"],
    });
    expect(wrongScope.status).toBe(401);
    const verify = await call("/api/support-cases/evidence-bundle/verify", {
      method: "POST",
      body: JSON.stringify(validBundle),
    });
    expect(verify.status).toBe(401);
    expect(mocks.exportBundle).not.toHaveBeenCalled();
    expect(mocks.verifyBundle).not.toHaveBeenCalled();
  });

  it("returns the bundle as a private, uncacheable response with the admin as actor", async () => {
    mocks.exportBundle.mockResolvedValue({ manifestChecksum: "abc" });
    const res = await call(`/api/support-cases/${CASE_ID}/evidence-bundle`, {
      scope: ["support:read"],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.exportBundle).toHaveBeenCalledWith(CASE_ID, expect.objectContaining({ actor: "support-admin" }));
  });

  it("returns 404 for an unknown case", async () => {
    mocks.exportBundle.mockResolvedValue(null);
    const res = await call(`/api/support-cases/${CASE_ID}/evidence-bundle`, { scope: ["support:read"] });
    expect(res.status).toBe(404);
  });

  it("returns 503 without a bundle when the export cannot be anchored", async () => {
    mocks.exportBundle.mockRejectedValue(new EvidenceAnchorError(new Error("db down")));
    const res = await call(`/api/support-cases/${CASE_ID}/evidence-bundle`, { scope: ["support:read"] });
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("manifestChecksum");
  });

  it("returns a generic 500 that does not leak internal errors", async () => {
    mocks.exportBundle.mockRejectedValue(new Error("MongoServerError at 10.0.0.9:27017"));
    const res = await call(`/api/support-cases/${CASE_ID}/evidence-bundle`, { scope: ["support:read"] });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("10.0.0.9");
  });

  it("rejects malformed and oversized bundles before verifying", async () => {
    const malformed = await call("/api/support-cases/evidence-bundle/verify", {
      method: "POST",
      scope: ["support:read"],
      body: JSON.stringify({ case: { caseId: CASE_ID } }),
    });
    expect(malformed.status).toBe(400);

    const oversized = await call("/api/support-cases/evidence-bundle/verify", {
      method: "POST",
      scope: ["support:read"],
      body: JSON.stringify({
        ...validBundle,
        audit: { records: Array.from({ length: 10_001 }, () => ({})), integrityChecksum: "" },
      }),
    });
    expect(oversized.status).toBe(413);
    expect(mocks.verifyBundle).not.toHaveBeenCalled();
  });

  it("returns the verification result", async () => {
    mocks.verifyBundle.mockResolvedValue({ valid: true });
    const res = await call("/api/support-cases/evidence-bundle/verify", {
      method: "POST",
      scope: ["support:read"],
      body: JSON.stringify(validBundle),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });
});
