import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// Page chrome needs wallet/i18n providers that are irrelevant to status rendering.
vi.mock("@/components/navigation", () => ({ Navigation: () => null }));
vi.mock("@/components/footer", () => ({ Footer: () => null }));

import StatusPage, { resolveState, STATE_COPY, type StatusResponse } from "../../pages/status/page";

const base: StatusResponse = {
  status: "up",
  timestamp: "2026-10-17T10:00:00.000Z",
  uptime: 120,
  services: [{ name: "Stellar RPC", status: "up", latencyMs: 40 }],
};

function mockStatus(body: StatusResponse) {
  vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => body } as Response);
}

describe("Status page public states (#986)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to the legacy status for responses without a state", () => {
    expect(resolveState({ ...base, status: "up" })).toBe("operational");
    expect(resolveState({ ...base, status: "degraded" })).toBe("degraded");
    expect(resolveState({ ...base, status: "down" })).toBe("outage");
    expect(resolveState({ ...base, status: "degraded", state: "paused" })).toBe("paused");
  });

  it("tells users the marketplace is paused", async () => {
    mockStatus({ ...base, status: "degraded", state: "paused", paused: true });
    render(<StatusPage />);
    expect(await screen.findByText(STATE_COPY.paused.title)).toBeTruthy();
  });

  it("shows the active maintenance window", async () => {
    mockStatus({
      ...base,
      status: "degraded",
      state: "maintenance",
      maintenance: [
        {
          id: "b1",
          title: "Indexer reindex",
          message: "Listings may lag for up to an hour.",
          endsAt: "2026-10-17T12:00:00.000Z",
        },
      ],
    });
    render(<StatusPage />);
    expect(await screen.findByText(STATE_COPY.maintenance.title)).toBeTruthy();
    expect(screen.getByText("Indexer reindex")).toBeTruthy();
    expect(screen.getByText("Listings may lag for up to an hour.")).toBeTruthy();
  });

  it("renders the public reason code instead of raw error text", async () => {
    mockStatus({
      ...base,
      status: "degraded",
      state: "degraded",
      services: [{ name: "Unlock Service", status: "down", latencyMs: null, error: "unreachable" }],
    });
    render(<StatusPage />);
    expect(await screen.findByText("unreachable")).toBeTruthy();
    expect(screen.getByText(STATE_COPY.degraded.title)).toBeTruthy();
  });
});
