# Time-Bounded Support Access (Maintainer Impersonation)

Status: implemented on the `feat/notify-support-import-safety` branch.

## Model

`SupportAccessGrant` is a **time-bounded, scoped, revocable** session that
lets an operator read user-scoped data for support. It is deliberately not a
standalone credential:

- every request needs a valid admin bearer token carrying `support:use` **and**
  an `x-support-grant-id` header naming a live grant;
- the grant must belong to the token's `sub` (`actor`), carry the exact scope
  the route requires, be unexpired, unrevoked, and within its use budget;
- TTL is capped at 24 h (`MAX_SUPPORT_GRANT_TTL_MS`); default 2 h. `maxUses`
  defaults to 25, hard-capped at 1000;
- users receive a **mandatory** `support_access_notice` (preference-proof)
  when a session is opened and when it ends;
- every allow/deny writes to the tamper-evident audit trail
  (`support_access_granted` / `support_access_used` / `support_access_denied` /
  `support_access_revoked`), with the target wallet stored as a SHA-256 hash.

## API surface

| Route                                                         | Admin scope                                            | Notes                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/admin/support-access/grants`                       | `support:grant`                                        | Body: `{ targetWallet, scopes[], reason, ttlMs?, maxUses? }`. Returns the grant id + expiry; `noticeDelivered` tells ops whether the user notice landed. |
| `GET /api/admin/support-access/grants`                        | `support:read`                                         | Filters: `actor`, `targetWallet`, `active=true`.                                                                                                         |
| `GET /api/admin/support-access/grants/:grantId`               | `support:read`                                         | Redacted summary (no reason text).                                                                                                                       |
| `POST /api/admin/support-access/grants/:grantId/revoke`       | `support:grant`                                        | Idempotent; sends the end-of-session notice.                                                                                                             |
| `GET /api/admin/support-access/sessions/:wallet/entitlements` | `support:use` + live grant `support:entitlements:read` | Read-only entitlement states; every call consumes one use and is audited.                                                                                |
| `GET /api/admin/support-access/audit?walletAddress=`          | `support:audit`                                        | Audit query for a wallet (hashed at rest).                                                                                                               |

Grantable scopes (allow-list): `support:read`, `support:entitlements:read`,
`support:unlock:diagnose`. Anything else is rejected at issuance; a grant can
never widen itself at use time.

## Operator runbook

1. Mint a short-lived admin token with `support:grant` (issuance) or
   `support:use` (session use). Tokens are minted out-of-band; see
   `docs/operations/audit-log-usage.md` for token mechanics.
2. Issue a grant with a ticket reference in `reason` (min 8 chars):
   `POST /grants { targetWallet, scopes: ["support:entitlements:read"], reason: "SUP-1042", ttlMs: 3600000 }`.
3. Use the grant by adding `x-support-grant-id: sag_…` to session requests.
4. Revoke when done; the session also expires automatically at `expiresAt`.

## Edge cases and failure modes

- **Expiry races.** Uses are consumed atomically with
  `expiresAt: { $gt: now }` and `uses < maxUses` in the update filter. If the
  grant expires between evaluation and consumption the request is denied
  (`use_conflict`) and audited — a use can never happen after expiry.
- **Actor mismatch.** Another operator's token cannot use someone else's
  grant (`actor_mismatch`, HTTP 403, audited).
- **Guard misconfiguration.** If `requireSupportAccess` is ever mounted
  without admin auth, it fails closed (503) and audits the denial; it cannot
  degenerate into a bypass.
- **Notice delivery failure.** Grant issuance and revocation never roll back
  because SMTP/notification storage failed; failures are logged and the audit
  record still exists. Replay the notice by re-delivering with the same
  dedupeKey (`support_access:<grantId>:issued|revoked`).
- **Storage outage.** Grant lookups and use-consumption failures deny the
  request (503/403) and audit `storage_error`. Availability favors denial.

## Rollback / recovery

- To terminate all active access immediately: revoke the grants
  (`POST /grants/:id/revoke`) and/or rotate `ADMIN_TOKEN_SECRET`, which
  invalidates every admin token; live grants without a valid token are inert.
- To **disable the feature**: unmount `supportAccessRouter` in
  `server/src/server.ts`. Existing grants become unusable (no routes) and
  expire naturally; the collection can be dropped independently since no
  other feature reads it.
- To audit a disputed session: `GET /api/admin/support-access/audit?walletAddress=G…`
  and cross-check `support_access_used` reasons for grant id, scopes, and
  use counts; the hash chain is verifiable via `verifyAuditTrail()`.

## Verification

```bash
cd server
npx vitest run src/tests/supportAccess.test.ts
```
