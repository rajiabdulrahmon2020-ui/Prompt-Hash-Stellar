# Support Evidence Bundles (#967)

An evidence bundle is an exportable, privacy-preserving record of one support
case. It is meant to be shared with people outside the support tool, such as
auditors, partners, or the buyer and creator. It keeps the identifiers,
timestamps, and hashes needed to check what happened, and it never includes
secrets or personal data.

## Endpoints

Both endpoints require an admin token with the `support:read` scope.

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/support-cases/:caseId/evidence-bundle` | The bundle, sent with `Cache-Control: private, no-store` |
| `POST` | `/api/support-cases/evidence-bundle/verify` | `{ valid, manifestValid, anchored, audit, errors }` |

## What the bundle contains

| Section | Kept as-is | Transformed | Never included |
|---|---|---|---|
| `case` | case ID, type, status, resolution, prompt ID, purchase ID, timestamps | buyer, creator, assignee, and note authors become `hashWalletAddress` hashes; title, description, notes, resolution note, and evidence URLs become `{ sha256, length }` | raw wallets, free text, URLs |
| `purchases` (up to 50, then `purchasesTruncated: true`) | purchase ID, prompt ID, Stellar `txHash`, status, version and license indexes, timestamps | buyer wallet becomes a hash | — |
| `audit` | the existing #783 audit export for this buyer on this prompt (up to 1,000 records) | wallet becomes a hash | client IPs, metadata, before/after state |

- **Wallet hashes** use the same SHA-256 the audit trail already stores, so
  case, purchase, and audit records correlate. Stellar addresses are public,
  so these hashes are pseudonymous, not anonymous: anyone who already knows
  an address can confirm it, and nobody can recover one from the bundle.
- **Text digests** let anyone holding the original text prove it matches.
  Short, guessable values (for example the title "Cannot unlock") can be
  confirmed by guessing, but they still cannot be read from the bundle.
- **Transaction hashes** are public on-ledger settlement proofs. Look one up
  with Horizon `GET /transactions/:transaction_hash` or any Stellar explorer.

## Integrity

1. `manifestChecksum` is the SHA-256 of the canonical JSON of `bundleVersion`,
   `generatedAt`, `case`, `purchases`, `purchasesTruncated`, and `audit`.
2. On export, the checksum is written to the hash-chained audit trail as an
   `audit_export` record:
   - `target` is the case ID;
   - `targetType` is `support_evidence_bundle`;
   - `reason` is `manifest=<checksum> records=<n>`.
   The `reason` and `target` fields are covered by that record's own hash.
3. Verification checks three things:
   - the content still matches the checksum;
   - an intact anchor record exists for that checksum;
   - every embedded audit record matches the stored chain (`verifyAuditExport`).

   Someone who edits the bundle and recomputes the checksum fails the
   anchor check.

Export cost is O(n + p + a) time and memory for n notes and URLs,
p ≤ 50 purchases, and a ≤ 1,000 audit records. Every query uses an existing
index.

## Failure modes

| Situation | Response |
|---|---|
| The anchor record cannot be written | `503`; no bundle is released, because an unanchored bundle could not be verified |
| Unknown or malformed case ID | `404` |
| Any other error | Generic `500`; details stay in the server logs |
| Verify body missing fields | `400` |
| Verify body with more than 10,000 audit records | `413` |
| The buyer has more than 1,000 audit events on the prompt | `audit.hasMore: true`; page further with `GET /api/audit/export?after=<audit.nextCursor>` |
| The case has no linked purchase | All purchases by the buyer for that prompt are included |

## Operational edge cases

- **Retries are safe.** Each export creates its own anchor, and every bundle
  verifies independently. Repeated exports only add audit records.
- **The case changes after export.** The bundle stays a valid snapshot of its
  `generatedAt` time. Export again to capture the new state.
- **Audit retention.** If audit records or the anchor are deleted by
  retention, older bundles can no longer be fully verified. Export again
  before the retention window ends if long-term proof is needed.

## Rollback

Remove the two routes from `server/src/routes/supportCaseRoutes.ts` and
delete `server/src/services/supportEvidenceBundle.ts`. Nothing else depends
on them. Anchor records already written are ordinary `audit_export` entries
and stay valid in the chain.
