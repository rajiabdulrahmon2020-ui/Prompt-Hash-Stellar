# Notification Preference & Mandatory-Alert Routing

Status: implemented on the `feat/notify-support-import-safety` branch.

## What ships

| Surface                                      | Behavior                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/notifications/:wallet/preferences` | Returns effective per-type channel preferences plus the `optionalTypes` / `mandatoryTypes` policy lists.                                                                                              |
| `PUT /api/notifications/:wallet/preferences` | Partial update, body `{ preferences: { prompt_update: { inApp: false, email: true } } }`. Only optional types are accepted; mandatory types return `400` with code `mandatory_type_not_configurable`. |
| `deliverNotification()`                      | Single routing entry point. Optional types respect preferences; mandatory types ignore them. Every writer that must not be silenced uses this.                                                        |
| `Notification` collection                    | One durable row per delivery. `mandatory: true` marks preference-proof alerts; `dedupeKey` makes deliveries exactly-once (unique partial index).                                                      |
| Audit trail                                  | `notification_preference_updated` on preference writes, `notification_mandatory_delivered` on every mandatory alert (including duplicate-suppressed retries).                                         |

Delivery classes (source of truth: `server/src/models/Notification.ts`):

- **Optional** — `prompt_update`, `purchase_receipt`.
- **Mandatory** — `security_alert`, `account_lifecycle`, `entitlement_update`,
  `support_access_notice`. These are lifecycle/security alerts: account
  security events, entitlement revocations/refunds, and support-session
  notices.

## Preference resolution order

1. Defaults: `{ inApp: true, email: true }` for every type (matches the
   historical email opt-in default — no behavior change for existing users).
2. Legacy `User.notificationPreferences` email opt-outs
   (`PromptUpdated` → `prompt_update`, `PromptPurchased` → `purchase_receipt`).
3. `NotificationPreference` document (the durable store; this is the only
   thing the API writes).
4. Mandatory types are forced on after all merging, so neither a legacy value
   nor a corrupted stored row can mute them.

## Edge cases and failure modes

- **Preferences store unavailable.** Reads degrade to defaults. Optional
  types may over-deliver during the outage; mandatory alerts still persist.
  Deliveries are never dropped because a preferences read failed.
- **Duplicate event projections.** Supply a stable `dedupeKey`
  (e.g. `prompt_update:<promptId>:v<N>:<wallet>`). A duplicate-key write is
  converted into an `alreadyDelivered: true` receipt; the mandatory audit
  record is still written so the audit trail shows the retry.
- **Recipient cleared notifications.** `DELETE /api/notifications/:wallet`
  deletes rows but does not delete the preference document; dedupeKeys of
  already-delivered mandatory alerts remain in effect (rows were deleted, so
  they can be re-delivered — operators replaying events should use a new
  event id if re-delivery is intended).
- **Preference write validation.** Unknown type → `unknown_notification_type`;
  mandatory type → `mandatory_type_not_configurable`; non-boolean channel →
  `invalid_channel_value`. Validation happens before any DB write.

## Rollback / recovery

- Preference writes are additive documents; deleting a
  `notificationpreferences` document (or a single type entry) restores the
  default opt-in behavior instantly. No migration required.
- The `Notification` schema changes are additive (relaxed required fields,
  new optional `mandatory`/`dedupeKey`). Rolling back application code leaves
  the collection readable by the previous version; the extra fields are
  ignored.
- If a mandatory alert was persisted but its audit record was lost (audit
  store outage), reconstruct the delivery window from `Notification` rows
  filtered by `mandatory: true` and `createdAt`, then reconcile against
  `GET /api/admin/support-access/audit`.

## Verification

```bash
cd server
npx vitest run src/tests/notificationRouting.test.ts
```
