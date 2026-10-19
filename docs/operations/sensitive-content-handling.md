# Sensitive-Content Boundaries (Rendering, Downloads, Webhooks, Exports)

Status: implemented on the `feat/notify-support-import-safety` branch.

Prompt copy, buyer-supplied values, operator notes, and catalog imports are all
untrusted content. This document maps each outbound surface to its boundary
control and the tests that prove it.

## Surface map

| Surface                                         | Control                                                                                                                                    | Where                                                                                                 | Tests                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Prompt rendering                                | `react-markdown` + `rehype-sanitize` default schema; no raw HTML pass-through; links forced to `target="_blank" rel="noopener noreferrer"` | `src/components/MarkdownContent.tsx`                                                                  | `src/test/components/MarkdownContent.test.tsx`    |
| CSV downloads (payout statement, ledger export) | RFC4180 quoting + formula-injection neutralization (`escapeCsvField`/`buildCsv`); sanitized `Content-Disposition` filenames                | `server/src/services/sensitiveContent.ts`, wired in `payoutLedgerRoutes.ts`, `purchaseControllers.ts` | `server/src/tests/sensitiveContent.test.ts`       |
| Webhook payloads                                | Deep deny-list redaction before hashing/persisting (`redactSensitiveFields` in `webhookOutbox.enqueue`)                                    | `server/src/services/webhookOutbox.ts`                                                                | `server/src/tests/sensitiveContent.test.ts`       |
| Exports                                         | Explicit allow-list projection (`projectAllowedFields`) + CSV escaping for export rows                                                     | `server/src/services/sensitiveContent.ts`                                                             | `server/src/tests/sensitiveContent.test.ts`       |
| Audit exports                                   | Wallet hashing + redacted filters (pre-existing)                                                                                           | `server/src/services/auditTrail.ts`                                                                   | `server/src/tests/auditTrail.test.ts` (DB-backed) |

## What the boundary guarantees

Rendering:

- no `<script>`, `iframe`, `object`, `embed`, `form`, `svg` elements survive;
- no event-handler attributes (`onerror`, `onclick`, …) survive;
- `javascript:` / `data:` URLs are stripped from `href`/`src`;
- `style` attributes are not allowed, so `url(javascript:…)` CSS smuggling is
  impossible;
- ordinary markdown (headings, bold, code, lists, links) still renders.

Downloads and exports:

- a crafted cell value (`=HYPERLINK(...)`, `+1+1`, `\t=cmd|…`) can never
  execute in a reviewer's spreadsheet — dangerous leading characters are
  prefixed with `'` and the cell is always quoted;
- quotes are doubled, so values cannot break out of the cell;
- filenames derived from route params (e.g. wallet address) are stripped of
  CR/LF, quotes, control characters, and path separators, so they cannot
  inject headers or traverse paths;
- exports only ship fields on their allow-list — adding a private field to a
  model cannot silently leak it.

Webhooks:

- fields matching the deny-list (`secret`, `privateKey`, `encryptedPrompt`,
  `plaintext`, `ciphertext`, tokens, passwords, nonces, …) are replaced with
  `[REDACTED]` at any depth before the payload is hashed or persisted;
- strings/depth/breadth are bounded (defaults: 4096 chars, depth 6, 100
  entries) so a subscriber or projection cannot blow up the outbox;
- the payload hash is computed over the redacted payload, so subscribers can
  still verify `sha256(canonical(body)) == X-PromptHash-Payload-Hash`;
- the subscription's signing secret is used only for the HMAC header and never
  appears in the body.

## Edge cases and failure modes

- **Pre-existing outbox rows** created before this change still contain their
  original (possibly sensitive) payload. The boundary applies at enqueue
  time; a delivery worker cannot rewrite a payload without breaking the
  stored `payloadHash`. If a dead-lettered legacy row must be inspected,
  treat its contents as sensitive.
- **Over-redaction.** A legitimate field named e.g. `nonce` or a >4096-char
  description is redacted/truncated. The trade-off is deliberate: webhook
  subscribers should never rely on fields that look like credentials. Extend
  the pattern only with review.
- **CSV consumers expecting raw numbers.** All cells are quoted; numeric
  values remain numeric-looking inside quotes (`"-12.5"`). Spreadsheet
  auto-detection handles quoted numeric cells; custom parsers must use a
  CSV library, not `split(",")`.
- **Filenames are not identity.** Sanitization is lossy by design; never
  parse data back out of a download filename.

## Rollback / recovery

- All controls are pure functions plus one-line wire-ins. Reverting the
  branch restores prior behavior; no data migration is required.
- If a bad payload was already persisted in the outbox before redaction was
  wired: identify rows via the dead-letter tools
  (`listDeadLetters`/`replayDeadLetter`) and delete or quarantine them rather
  than replaying to subscribers.
- If a CSV export leaked a formula because a new export path bypassed
  `escapeCsvField`, fix the call site and rotate reviewer accounts that
  opened the file; grep for `"text/csv"` to find export paths:

  ```bash
  grep -rn "text/csv" server/src
  ```

## Verification

```bash
cd server && npx vitest run src/tests/sensitiveContent.test.ts
npx vitest run src/test/components/MarkdownContent.test.tsx   # from repo root
```
