// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ErrorCode } from "../../src/lib/api/errorCodes";
import { verifyChallengeToken } from "../../src/lib/auth/challenge";

const mocks = vi.hoisted(() => ({ recordAuditEvent: vi.fn() }));

vi.mock("../../src/lib/observability/wrapper", () => ({
  withObservability: (handler: unknown) => handler,
}));
vi.mock("../../src/lib/observability/rateLimiter", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 }),
}));
vi.mock("../../server/src/services/auditTrail", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}));

import handler from "./challenge";
import { requireWalletSession } from "../../server/src/middleware/walletSession";

const SECRET = "challenge-secret-for-threat-model-tests";
const victim = Keypair.random().publicKey();

async function requestChallenge(body: Record<string, unknown>) {
  let statusCode = 200;
  let responseData: any = {};
  const req = {
    method: "POST",
    headers: {},
    body,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    requestId: "test-request",
    socket: { remoteAddress: "127.0.0.1" },
  };
  const res = {
    setHeader: vi.fn(),
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      responseData = data;
      return this;
    },
  };
  await handler(req, res);
  return { statusCode, responseData };
}

/** Present a token to the server's wallet-session gate for `wallet`. */
function walletSessionAdmits(token: string, wallet: string): boolean {
  const next = vi.fn();
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  requireWalletSession(() => wallet)(
    { headers: { authorization: `Bearer ${token}` } } as any,
    res,
    next,
  );
  return next.mock.calls.length === 1;
}

describe("public challenge issuer trust boundary (#963)", () => {
  beforeEach(() => {
    process.env.CHALLENGE_TOKEN_SECRET = SECRET;
    mocks.recordAuditEvent.mockClear();
  });

  afterEach(() => {
    delete process.env.CHALLENGE_TOKEN_SECRET;
  });

  it("refuses to mint a wallet-session bearer token for an arbitrary wallet", async () => {
    // Abuse case TM-1: an unauthenticated caller asks the public issuer for a
    // token shaped like a wallet session for someone else's wallet.
    const { statusCode, responseData } = await requestChallenge({
      address: victim,
      promptId: "wallet-session",
      action: "wallet_session",
    });

    expect(statusCode).toBe(400);
    expect(responseData.code).toBe(ErrorCode.CHALLENGE_INVALID);
    expect(responseData).not.toHaveProperty("token");
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "challenge_issued",
        result: "blocked",
        reason: "unsupported_action",
      }),
    );
  });

  it.each(["wallet_session_challenge", "external_identity_link", "admin", ""])(
    "refuses the non-public action %j",
    async (action) => {
      const { statusCode, responseData } = await requestChallenge({
        address: victim,
        promptId: "42",
        action,
      });
      expect(statusCode).toBe(400);
      expect(responseData).not.toHaveProperty("token");
    },
  );

  it("still issues unlock challenges, by default and when named explicitly", async () => {
    for (const body of [
      { address: victim, promptId: "42" },
      { address: victim, promptId: "42", action: "unlock" },
    ]) {
      const { statusCode, responseData } = await requestChallenge(body);
      expect(statusCode).toBe(200);
      const payload = verifyChallengeToken(SECRET, responseData.token, victim, "42");
      expect(payload.action).toBe("unlock");
    }
  });

  it("issues nothing the wallet-session gate accepts, whatever the subject", async () => {
    // Even with the session subject as promptId, the issued token carries the
    // unlock action, which the server-side session gate rejects.
    const { statusCode, responseData } = await requestChallenge({
      address: victim,
      promptId: "wallet-session",
    });

    expect(statusCode).toBe(200);
    expect(walletSessionAdmits(responseData.token, victim)).toBe(false);
  });
});
