// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectDb: vi.fn(),
  findOne: vi.fn(),
  runAllProbes: vi.fn(),
  listActive: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock("../server/src/db/connectDb", () => ({ default: mocks.connectDb }));
vi.mock("../server/src/models/IndexerState", () => ({
  IndexerState: { findOne: mocks.findOne },
}));
vi.mock("../server/src/services/healthProbes", () => ({
  runAllProbes: mocks.runAllProbes,
  calculateOverallHealth: vi.fn(),
}));
vi.mock("../server/src/services/maintenanceBannerService", () => ({
  maintenanceBannerService: { listActive: mocks.listActive },
}));
vi.mock("../src/lib/stellar/tx", () => ({ readContract: mocks.readContract }));

import handler from "./status";

const ENV_KEYS = [
  "PUBLIC_PROMPT_HASH_CONTRACT_ID",
  "PUBLIC_STELLAR_SIMULATION_ACCOUNT",
  "CHALLENGE_TOKEN_SECRET",
] as const;

function createResponse() {
  return {
    statusCode: 0,
    body: undefined as any,
    setHeader: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

async function getStatus() {
  const res = createResponse();
  await handler({ method: "GET", headers: {}, url: "/api/status" }, res);
  return res;
}

function healthyFetch(input: RequestInfo | URL) {
  const url = String(input);
  if (url.includes("/api/health")) return Promise.resolve(new Response("{}", { status: 200 }));
  if (url.includes("soroban")) {
    return Promise.resolve(Response.json({ result: { status: "healthy" } }));
  }
  return Promise.resolve(new Response("{}", { status: 200 }));
}

const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

describe("GET /api/status public status (#986)", () => {
  beforeEach(() => {
    // vite-plugin-node-polyfills swaps in a browser `process` shim without
    // uptime(); the real Node/Vercel runtime always has it.
    (process as { uptime?: () => number }).uptime ??= () => 1;
    vi.clearAllMocks();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID = "CCONTRACT";
    process.env.PUBLIC_STELLAR_SIMULATION_ACCOUNT = "GSIMULATION";
    process.env.CHALLENGE_TOKEN_SECRET = "challenge-secret-value-that-must-not-leak";

    mocks.connectDb.mockResolvedValue(undefined);
    mocks.findOne.mockResolvedValue({ lastIndexedLedger: 0, leaseHolder: null });
    mocks.runAllProbes.mockResolvedValue([]);
    mocks.listActive.mockResolvedValue([]);
    mocks.readContract.mockResolvedValue(false);
    vi.spyOn(globalThis, "fetch").mockImplementation(healthyFetch as typeof fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  it("reports operational with the legacy status field intact", async () => {
    const res = await getStatus();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ state: "operational", status: "up", paused: false });
    expect(mocks.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ simulationAccount: "GSIMULATION" }),
      "CCONTRACT",
      "is_paused",
    );
  });

  it("reports paused when the contract's is_paused view returns true", async () => {
    mocks.readContract.mockResolvedValue(true);
    const res = await getStatus();
    expect(res.body).toMatchObject({ state: "paused", status: "degraded", paused: true });
  });

  it("reports maintenance for an active window", async () => {
    const window = {
      id: "b1",
      title: "Indexer reindex",
      message: "Listings may lag.",
      severity: "info",
      scopes: ["marketplace"],
      affectedFeatures: [],
      startsAt: "2026-10-17T10:00:00.000Z",
      endsAt: "2026-10-17T12:00:00.000Z",
    };
    mocks.listActive.mockResolvedValue([window]);
    const res = await getStatus();
    expect(res.body).toMatchObject({ state: "maintenance", maintenance: [window] });
  });

  it("keeps serving status when the pause read or the banner store fails", async () => {
    mocks.readContract.mockRejectedValue(new Error("simulation failed at http://10.0.0.7:8000"));
    mocks.listActive.mockRejectedValue(new Error("mongo down"));
    const res = await getStatus();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ state: "operational", paused: null, maintenance: [] });
  });

  it("skips the pause read when the contract is not configured", async () => {
    delete process.env.PUBLIC_PROMPT_HASH_CONTRACT_ID;
    const res = await getStatus();
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(res.body.paused).toBeNull();
  });

  it("never publishes raw dependency errors, probe details, or secrets", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL) =>
      String(input).includes("/api/health")
        ? Promise.reject(new TypeError("connect ECONNREFUSED 10.0.4.12:3000"))
        : healthyFetch(input)) as typeof fetch);
    mocks.runAllProbes.mockResolvedValue([
      {
        name: "contract_read",
        status: "down",
        latencyMs: 15,
        error: "HostError: account GSIMULATION missing at http://internal-rpc:8000",
        details: { simulationAccount: "GSIMULATION" },
        timestamp: "2026-10-17T10:00:00.000Z",
      },
    ]);

    const res = await getStatus();
    const body = JSON.stringify(res.body);

    expect(res.body.state).toBe("degraded");
    expect(body).not.toContain("10.0.4.12");
    expect(body).not.toContain("internal-rpc");
    expect(body).not.toContain("GSIMULATION");
    expect(body).not.toContain("challenge-secret-value-that-must-not-leak");
    expect(res.body.services).toContainEqual(
      expect.objectContaining({ name: "Unlock Service", status: "down", error: "unreachable" }),
    );
    expect(res.body.probes[0]).not.toHaveProperty("details");
  });
});
