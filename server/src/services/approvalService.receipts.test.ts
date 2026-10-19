import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  approvals: [] as any[],
  receiptNumber: 0,
}));

vi.mock("../db/connectDb", () => ({ default: vi.fn().mockResolvedValue(true) }));
vi.mock("../services/signedReceiptService", () => ({
  SignedReceiptService: {
    createReceipt: vi.fn(async () => ({
      receiptId: `receipt-${++fake.receiptNumber}`,
    })),
  },
}));
vi.mock("../models/Approval", () => ({
  default: {
    create: vi.fn(async (input: any) => {
      const approval = {
        ...input,
        _id: "approval-1",
        save: vi.fn(async function (this: any) {
          return this;
        }),
      };
      fake.approvals.push(approval);
      return approval;
    }),
    findOne: vi.fn(async () => fake.approvals[0] ?? null),
  },
}));

import { ApprovalService } from "./approvalService";

describe("ApprovalService signed intent receipts", () => {
  beforeEach(() => {
    fake.approvals.length = 0;
    fake.receiptNumber = 0;
  });

  it("links pending intent and terminal outcome receipts", async () => {
    const approval = await ApprovalService.createApproval({
      actionId: "transfer-1",
      actionType: "ownershipTransfer",
      scope: "TRANSFER",
      reason: "recover a stuck settlement",
      actor: "GMAINTAINER",
      durationMinutes: 15,
    });
    expect(approval.intentReceiptId).toBe("receipt-1");

    approval.status = "approved";
    const completed = await ApprovalService.recordOutcome({
      approvalId: "approval-1",
      actor: "gmaintainer",
      status: "SUCCESS",
      details: { requestId: "req-1" },
    });

    expect(completed).toBe(approval);
    expect(completed.outcome).toBe("SUCCESS");
    expect(completed.outcomeReceiptId).toBe("receipt-2");
  });
});
