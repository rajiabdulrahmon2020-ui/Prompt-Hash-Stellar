import mongoose from "mongoose";

export interface ChannelPreference {
  inApp: boolean;
  email: boolean;
}

/**
 * Durable per-wallet notification preferences.
 *
 * Only optional notification types are persisted here; mandatory
 * lifecycle/security alerts are never configurable and are routed by policy
 * (see `MANDATORY_NOTIFICATION_TYPES` in `Notification.ts`). Update requests
 * that target a mandatory type are rejected by `notificationPreferences.ts`.
 *
 * Absence of a document (or of a type entry) means "default opt-in": in-app
 * and email both enabled. That matches the historical behaviour of
 * `emailNotifications.hasOptedIn`, so existing users see no change.
 */
const channelPreferenceSchema = new mongoose.Schema(
  {
    inApp: { type: Boolean, required: true },
    email: { type: Boolean, required: true },
  },
  { _id: false },
);

const notificationPreferenceSchema = new mongoose.Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    preferences: {
      type: Map,
      of: channelPreferenceSchema,
      default: {},
    },
  },
  { timestamps: true },
);

const NotificationPreference =
  mongoose.models.NotificationPreference ||
  mongoose.model("NotificationPreference", notificationPreferenceSchema);

export default NotificationPreference;
