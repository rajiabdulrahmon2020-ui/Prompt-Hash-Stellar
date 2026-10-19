import { describe, it, expect, vi, afterEach } from "vitest";
import {
  derivePublicStatus,
  toPublicReason,
  type ComponentCheck,
} from "../services/publicStatus";
import { maintenanceBannerService } from "../services/maintenanceBannerService";
import { MaintenanceBanner } from "../models/MaintenanceBanner";
import type { ProbeResult } from "../services/healthProbes";

const up = (name: string): ComponentCheck => ({ name, status: "up", latencyMs: 40 });

const banner = {
  id: "b1",
  title: "Wallet upgrade",
  message: "Wallet connections may be interrupted.",
  severity: "warning" as const,
  scopes: ["wallet" as const],
  affectedFeatures: ["wallet"],
  startsAt: "2026-10-17T10:00:00.000Z",
  endsAt: "2026-10-17T11:00:00.000Z",
};

function status(overrides: Partial<Parameters<typeof derivePublicStatus>[0]> = {}) {
  return derivePublicStatus({
    components: [up("Stellar RPC"), up("Horizon"), up("Unlock Service")],
    probes: [],
    maintenance: [],
    contractPaused: false,
    ...overrides,
  });
}

describe("derivePublicStatus state precedence (#986)", () => {
  it("is operational when every component is up and nothing is declared", () => {
    expect(status()).toMatchObject({ state: "operational", status: "up", paused: false });
  });

  it("is degraded when at least one component is not up", () => {
    const result = status({
      components: [up("Stellar RPC"), { name: "Horizon", status: "down", latencyMs: null }],
    });
    expect(result).toMatchObject({ state: "degraded", status: "degraded" });
  });

  it("is maintenance while a window is active, even if components are degraded", () => {
    const result = status({
      components: [up("Stellar RPC"), { name: "Horizon", status: "degraded", latencyMs: 900 }],
      maintenance: [banner],
    });
    expect(result).toMatchObject({ state: "maintenance", status: "degraded" });
    expect(result.maintenance).toEqual([banner]);
  });

  it("is paused when the contract is paused, ahead of maintenance", () => {
    expect(status({ contractPaused: true, maintenance: [banner] })).toMatchObject({
      state: "paused",
      status: "degraded",
      paused: true,
    });
  });

  it("is an outage when no component is up, ahead of paused", () => {
    const result = status({
      components: [
        { name: "Stellar RPC", status: "down", latencyMs: null },
        { name: "Horizon", status: "degraded", latencyMs: 4000 },
      ],
      contractPaused: true,
    });
    expect(result).toMatchObject({ state: "outage", status: "down" });
  });

  it("never claims paused when the flag could not be read", () => {
    expect(status({ contractPaused: null })).toMatchObject({ state: "operational", paused: null });
  });

  it("returns to operational once the pause is lifted and the window closes", () => {
    expect(status({ contractPaused: true, maintenance: [banner] }).state).toBe("paused");
    expect(status({ contractPaused: false, maintenance: [banner] }).state).toBe("maintenance");
    expect(status({ contractPaused: false, maintenance: [] }).state).toBe("operational");
  });
});

describe("public status redaction (#986)", () => {
  it("replaces raw error text with a fixed reason code", () => {
    const result = status({
      components: [
        up("Stellar RPC"),
        {
          name: "Unlock Service",
          status: "down",
          latencyMs: null,
          error: "connect ECONNREFUSED 10.0.4.12:3000",
        },
        {
          name: "contract_read",
          status: "down",
          latencyMs: 12,
          error: "Simulation failed: HostError contract CABC…XYZ secret=abc123",
        },
      ],
    });

    const body = JSON.stringify(result);
    expect(body).not.toContain("10.0.4.12");
    expect(body).not.toContain("secret=abc123");
    expect(body).not.toContain("HostError");
    expect(result.services[1].error).toBe("unreachable");
    expect(result.services[2].error).toBe("check_failed");
  });

  it("drops probe error text and details", () => {
    const probe: ProbeResult = {
      name: "contract_read",
      status: "down",
      latencyMs: 30,
      error: "RPC at http://internal-rpc:8000 refused",
      details: { simulationAccount: "GSIM…", promptId: "1" },
      timestamp: "2026-10-17T10:00:00.000Z",
    };
    const [published] = status({ probes: [probe] }).probes;
    expect(published).toEqual({
      name: "contract_read",
      status: "down",
      latencyMs: 30,
      timestamp: "2026-10-17T10:00:00.000Z",
    });
  });

  it("omits the error field on healthy components", () => {
    const result = status({ components: [{ ...up("Horizon"), error: "stale" }] });
    expect(result.services[0]).not.toHaveProperty("error");
  });

  it.each([
    ["The operation was aborted due to timeout", "timeout"],
    ["Contract read timeout", "timeout"],
    ["HTTP 503", "http_error"],
    ["RPC reported unhealthy", "unhealthy"],
    ["fetch failed", "unreachable"],
    ["getaddrinfo ENOTFOUND rpc.internal", "unreachable"],
    ["unexpected token < in JSON", "check_failed"],
  ] as const)("classifies %j as %s", (raw, code) => {
    expect(toPublicReason(raw)).toBe(code);
  });
});

describe("maintenanceBannerService.listActive (#986)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("queries enabled banners whose window contains now, across every scope", async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const find = vi
      .spyOn(MaintenanceBanner, "find")
      .mockReturnValue({ sort: () => ({ exec }) } as never);
    const now = new Date("2026-10-17T10:30:00.000Z");

    await maintenanceBannerService.listActive(now);

    expect(find).toHaveBeenCalledWith({
      enabled: true,
      startsAt: { $lte: now },
      endsAt: { $gt: now },
    });
  });

  it("returns only the public projection of each banner", async () => {
    const doc = {
      _id: "b1",
      title: "Wallet upgrade",
      message: "Wallet connections may be interrupted.",
      severity: "warning",
      scopes: ["wallet"],
      affectedFeatures: ["wallet"],
      startsAt: new Date(banner.startsAt),
      endsAt: new Date(banner.endsAt),
      enabled: true,
      createdBy: "GADMINWALLET",
      updatedBy: "GADMINWALLET2",
    };
    vi.spyOn(MaintenanceBanner, "find").mockReturnValue({
      sort: () => ({ exec: async () => [doc] }),
    } as never);

    const [published] = await maintenanceBannerService.listActive();
    expect(published).not.toHaveProperty("createdBy");
    expect(published).not.toHaveProperty("updatedBy");
    expect(published).not.toHaveProperty("enabled");
    expect(published).toMatchObject({ id: "b1", endsAt: banner.endsAt });
  });
});
