import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/auditTrail", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../models/Notification", () => ({
  default: {
    create: vi.fn(),
    findOne: vi.fn(),
  },
  NOTIFICATION_TYPES: [
    "prompt_update",
    "purchase_receipt",
    "security_alert",
    "account_lifecycle",
    "entitlement_update",
    "support_access_notice",
  ],
  MANDATORY_NOTIFICATION_TYPES: [
    "security_alert",
    "account_lifecycle",
    "entitlement_update",
    "support_access_notice",
  ],
  OPTIONAL_NOTIFICATION_TYPES: ["prompt_update", "purchase_receipt"],
  isMandatoryNotificationType: (type: string) =>
    [
      "security_alert",
      "account_lifecycle",
      "entitlement_update",
      "support_access_notice",
    ].includes(type),
}));

vi.mock("../models/NotificationPreference", () => ({
  default: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock("../models/User", () => ({
  default: {
    findOne: vi.fn(),
  },
}));

import Notification from "../models/Notification";
import NotificationPreference from "../models/NotificationPreference";
import User from "../models/User";
import { recordAuditEvent } from "../services/auditTrail";
import {
  buildEffectivePreferences,
  defaultEffectivePreferences,
  updateNotificationPreferences,
  validatePreferencePatch,
  NotificationPreferenceError,
} from "../services/notificationPreferences";
import {
  deliverNotification,
  planNotificationDelivery,
} from "../services/notificationRouting";

function leanQuery<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

describe("notification preference model (pure)", () => {
  it("defaults every notification type to opt-in", () => {
    const prefs = defaultEffectivePreferences();
    expect(prefs.prompt_update).toEqual({ inApp: true, email: true });
    expect(prefs.purchase_receipt).toEqual({ inApp: true, email: true });
    expect(prefs.security_alert).toEqual({ inApp: true, email: true });
  });

  it("honors stored opt-outs for optional types but never for mandatory types", () => {
    const prefs = buildEffectivePreferences({
      stored: {
        prompt_update: { inApp: false, email: false },
        support_access_notice: { inApp: false, email: false },
        security_alert: { inApp: false, email: false },
      },
    });

    expect(prefs.prompt_update).toEqual({ inApp: false, email: false });
    expect(prefs.support_access_notice).toEqual({ inApp: true, email: true });
    expect(prefs.security_alert).toEqual({ inApp: true, email: true });
  });

  it("maps legacy User.notificationPreferences email opt-outs onto new types", () => {
    const prefs = buildEffectivePreferences({
      legacyEmailOptOuts: { PromptUpdated: false, PromptPurchased: false },
    });

    expect(prefs.prompt_update).toEqual({ inApp: true, email: false });
    expect(prefs.purchase_receipt).toEqual({ inApp: true, email: false });
  });

  it("accepts Map-based stored preferences (Mongoose docs)", () => {
    const stored = new Map<string, unknown>([
      ["prompt_update", { inApp: false, email: true }],
    ]);
    const prefs = buildEffectivePreferences({ stored });
    expect(prefs.prompt_update.inApp).toBe(false);
  });

  it("rejects unknown types, mandatory types, and non-boolean channel values", () => {
    expect(() =>
      validatePreferencePatch({ not_a_type: { inApp: false } }),
    ).toThrow(NotificationPreferenceError);
    expect(() =>
      validatePreferencePatch({ security_alert: { inApp: false } }),
    ).toThrow(/mandatory/i);
    expect(() =>
      validatePreferencePatch({ prompt_update: { inApp: "no" } as never }),
    ).toThrow(/boolean/i);
  });
});

describe("planNotificationDelivery (pure)", () => {
  it("suppresses an optional type when the recipient opted out of in-app delivery", () => {
    const prefs = defaultEffectivePreferences();
    prefs.prompt_update = { inApp: false, email: true };

    const plan = planNotificationDelivery("prompt_update", prefs);

    expect(plan.suppressed).toBe(true);
    expect(plan.mandatory).toBe(false);
  });

  it("keeps mandatory lifecycle/security alerts deliverable even with muted preferences", () => {
    const prefs = defaultEffectivePreferences();
    for (const type of Object.keys(prefs) as Array<keyof typeof prefs>) {
      prefs[type] = { inApp: false, email: false };
    }

    for (const type of [
      "security_alert",
      "account_lifecycle",
      "entitlement_update",
      "support_access_notice",
    ] as const) {
      const plan = planNotificationDelivery(type, prefs);
      expect(plan.mandatory).toBe(true);
      expect(plan.suppressed).toBe(false);
      expect(plan.channels).toEqual({ inApp: true, email: true });
    }
  });
});

describe("deliverNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MONGODB_URI ||=
      "mongodb://127.0.0.1:27017/prompt-hash-stellar-test";
  });

  it("does not persist or audit an optional notification that preferences suppress", async () => {
    const prefs = defaultEffectivePreferences();
    prefs.prompt_update = { inApp: false, email: true };

    const receipt = await deliverNotification({
      recipientWallet: "GBUYER",
      type: "prompt_update",
      message: "should be suppressed",
      preferences: prefs,
    });

    expect(receipt.delivered).toBe(false);
    expect(receipt.suppressionReason).toBe("preference_disabled");
    expect(Notification.create).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("persists a mandatory alert and records it in the audit trail", async () => {
    (Notification.create as any).mockResolvedValue({ _id: "n1" });

    const receipt = await deliverNotification({
      recipientWallet: "GUSER",
      type: "support_access_notice",
      message: "A support session was opened.",
      dedupeKey: "support_access:sag_1:issued",
      requestId: "req-1",
    });

    expect(receipt.delivered).toBe(true);
    expect(receipt.mandatory).toBe(true);
    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "support_access_notice",
        mandatory: true,
        dedupeKey: "support_access:sag_1:issued",
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_mandatory_delivered",
        result: "success",
        walletAddress: "guser",
        requestId: "req-1",
      }),
    );
  });

  it("delivers exactly once for a repeated dedupeKey and still audits the retry", async () => {
    const dup = new Error("duplicate") as Error & { code?: number };
    dup.code = 11000;
    (Notification.create as any).mockRejectedValueOnce(dup);
    (Notification.findOne as any).mockReturnValue(
      leanQuery({ _id: "existing-row" }),
    );

    const receipt = await deliverNotification({
      recipientWallet: "GUSER",
      type: "security_alert",
      message: "New device signed in.",
      dedupeKey: "security_alert:event-9",
    });

    expect(receipt.alreadyDelivered).toBe(true);
    expect(receipt.delivered).toBe(false);
    expect(receipt.notificationId).toBe("existing-row");
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_mandatory_delivered",
        reason: expect.stringContaining("duplicate=true"),
      }),
    );
  });

  it("re-throws non-duplicate persistence errors so callers can alert on storage failures", async () => {
    (Notification.create as any).mockRejectedValueOnce(new Error("db down"));

    await expect(
      deliverNotification({
        recipientWallet: "GUSER",
        type: "security_alert",
        message: "x",
        dedupeKey: "k",
      }),
    ).rejects.toThrow("db down");
  });

  it("degrades to default opt-in when the preferences store is unreachable", async () => {
    (NotificationPreference.findOne as any).mockImplementation(() => ({
      lean: vi.fn().mockRejectedValue(new Error("preferences db down")),
    }));
    (User.findOne as any).mockImplementation(() => ({
      lean: vi.fn().mockResolvedValue(null),
    }));
    (Notification.create as any).mockResolvedValue({ _id: "n2" });

    const receipt = await deliverNotification({
      recipientWallet: "GUSER",
      type: "prompt_update",
      message: "still delivered",
    });

    expect(receipt.delivered).toBe(true);
    expect(Notification.create).toHaveBeenCalled();
  });
});

describe("updateNotificationPreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an allowed optional patch and audits the change", async () => {
    // First findOne = pre-write merge read; second = effective-preferences read.
    (NotificationPreference.findOne as any)
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(
        leanQuery({
          preferences: { prompt_update: { inApp: false, email: true } },
        }),
      );
    (NotificationPreference.findOneAndUpdate as any).mockResolvedValue({});
    (User.findOne as any).mockReturnValue(leanQuery(null));

    const prefs = await updateNotificationPreferences("GUSER", {
      prompt_update: { inApp: false },
    });

    expect(prefs.prompt_update).toEqual({ inApp: false, email: true });
    expect(NotificationPreference.findOneAndUpdate).toHaveBeenCalledWith(
      { walletAddress: "guser" },
      expect.objectContaining({
        $set: expect.objectContaining({
          "preferences.prompt_update.inApp": false,
          "preferences.prompt_update.email": true,
        }),
      }),
      expect.anything(),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_preference_updated",
        result: "success",
      }),
    );
  });

  it("refuses to mute a mandatory alert before any write happens", async () => {
    await expect(
      updateNotificationPreferences("GUSER", {
        security_alert: { inApp: false },
      }),
    ).rejects.toThrow(/mandatory/i);
    expect(NotificationPreference.findOneAndUpdate).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
