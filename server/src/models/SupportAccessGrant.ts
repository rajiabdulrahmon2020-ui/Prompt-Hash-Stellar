import mongoose from "mongoose";

/**
 * Fine-grained scopes a support session may carry. Everything else is denied
 * by `evaluateSupportGrant` — a grant can never widen itself at use time.
 */
export const SUPPORT_ACCESS_SCOPES = [
  "support:read",
  "support:entitlements:read",
  "support:unlock:diagnose",
] as const;

export type SupportAccessScope = (typeof SUPPORT_ACCESS_SCOPES)[number];

/**
 * Time-bounded maintainer/support impersonation grant.
 *
 * A grant is *not* a bearer credential on its own: every use must arrive
 * through an admin-authenticated request (`requireAdminScope("support:use")`)
 * whose token `sub` matches `actor`, must carry `x-support-grant-id`, and is
 * re-validated (expiry, revocation, scope, use budget) on every call by
 * `requireSupportAccess`. All uses and denials are written to the
 * tamper-evident audit trail.
 */
const supportAccessGrantSchema = new mongoose.Schema(
  {
    grantId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Admin token `sub` of the operator who opened the session.
    actor: {
      type: String,
      required: true,
      index: true,
    },
    targetWallet: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    scopes: {
      type: [String],
      required: true,
      enum: SUPPORT_ACCESS_SCOPES as unknown as string[],
    },
    reason: {
      type: String,
      required: true,
      maxLength: 500,
    },
    issuedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    maxUses: {
      type: Number,
      required: true,
      default: 25,
      min: 1,
      max: 1000,
    },
    uses: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: String,
      default: null,
    },
    // Reference to the mandatory user-safe notice delivered when the grant
    // was issued (and a second one when it is revoked).
    noticeNotificationId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

supportAccessGrantSchema.index({ targetWallet: 1, expiresAt: -1 });
supportAccessGrantSchema.index({ actor: 1, expiresAt: -1 });
supportAccessGrantSchema.index({ revokedAt: 1, expiresAt: 1 });

const SupportAccessGrant =
  mongoose.models.SupportAccessGrant ||
  mongoose.model("SupportAccessGrant", supportAccessGrantSchema);

export default SupportAccessGrant;
