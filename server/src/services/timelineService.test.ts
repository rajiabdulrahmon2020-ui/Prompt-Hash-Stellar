import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  find: vi.fn(),
}));

vi.mock("../models/TimelineEvent", () => ({ default: fake }));

import { TimelineService } from "./timelineService";

describe("TimelineService cursor pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the timestamp and id boundary for stable pages", async () => {
    const boundary = new Date("2026-10-16T12:00:00.000Z");
    const results = [
      { _id: "event-1", createdAt: boundary },
      { _id: "event-2", createdAt: new Date("2026-10-16T11:59:00.000Z") },
    ];
    const chain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(results),
    };
    fake.find.mockReturnValue(chain);

    const firstPage = await TimelineService.getTimeline({ wallet: "GUSER", limit: 1 });
    const cursor = firstPage.metadata.nextCursor as string;
    await TimelineService.getTimeline({ wallet: "GUSER", limit: 1, cursor });

    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    const secondQuery = fake.find.mock.calls[1][0];
    expect(secondQuery.$or).toEqual([
      { createdAt: { $lt: boundary } },
      { createdAt: boundary, _id: { $lt: "event-1" } },
    ]);
  });
});
