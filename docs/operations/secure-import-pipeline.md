# Secure Import Pipeline

Status: implemented on the `feat/notify-support-import-safety` branch.

## Flow

```text
rows ──▶ previewPromptImport() ──▶ ImportPreview { previewId, create[], update[], quarantined[] }
                                        │
                                        ▼  (operator reviews; optional edits restart at preview)
        commitPromptImport(store, rows, { previewId })
                                        │  refuses on previewId mismatch
                                        ▼
                 ImportStore writes (importId + rowRef trace, snapshots for rollback)
                                        │
                                        ▼
        rollbackPromptImport(store, receipt)   ← reverse a commit (retry-safe)
```

- **Preview** validates rows, detects duplicates/ownership conflicts, and
  quarantines each rejected row with stable reason codes:
  `missing_identity`, `missing_creator`, `invalid_metadata`, `duplicate_row`,
  `ownership_mismatch`, `unsafe_payload`. It never writes to a store and never
  echoes raw payload references — only `row_<hash>` references and external
  catalog ids.
- **Commit** recomputes the preview id from the supplied rows and refuses
  (`ImportPreviewMismatchError`) if the operator edited rows after preview.
  Store state (ownership, duplicates) is re-validated at commit time. Every
  accepted row is stamped with the `importId` (= `previewId`) and its
  `rowRef`; updates snapshot the previous record for rollback.
- **Unsafe payloads** — rows containing deny-listed content (secrets, keys,
  strong plaintext/ciphertext markers) or oversized fields are quarantined as
  `unsafe_payload` even if they otherwise validate. Import is a data path,
  not a place to smuggle credentials into prompt metadata.

## Traceability

- `ImportReceipt` (returned by commit) lists per-row `action`
  (`created`/`updated`), `externalId`, and `rowRef`, plus the quarantine list,
  and carries a `receiptHash` for audit storage.
- Every stored record keeps `importId` + `rowRef`, so "which import created
  this listing?" is answerable from the record itself.
- Receipts deliberately omit `payloadRef` values and message bodies.

## Retry semantics

- Commit is **idempotent per `importId`**. A crash between two store writes,
  a timeout, or an operator retry re-runs the same commit: rows already
  stamped with the `importId` are skipped and reported with their original
  action, so the second receipt has the same `receiptHash` as the first.
- Retry with the **same rows** after fixing a transient failure; do not edit
  rows between attempts (the previewId binds content and the retry will be
  refused — re-run preview instead).
- A later import touching the same external ids proceeds normally; it
  snapshots the current state, so its own rollback still restores correctly.

## Rollback / recovery

- `rollbackPromptImport(store, receipt)` deletes rows this import created and
  restores updated rows from their commit-time snapshots.
- It is safe to re-run: already-reverted rows are skipped (`missing`).
- If another import has touched a row since (`importId` mismatch), rollback
  **skips** it as `superseded` instead of clobbering newer data. Resolve
  manually by comparing receipts; re-running the earlier import after the
  later one is not supported (last-writer-wins) — re-preview instead.
- A corrupt/missing snapshot is reported as `missing_snapshot`; the row is
  left in place and must be repaired from a database backup.

## Edge cases and failure modes

- **Partial commit + rollback.** Rollback only needs the stored trace; rows
  the failed attempt never wrote are reported `missing`.
- **Duplicate external ids inside one payload.** First occurrence wins; later
  ones are quarantined (`duplicate_row`) — import never silently merges.
- **Ownership conflicts.** A row whose `creatorWallet` differs from the
  existing record is quarantined, never updated; this prevents one creator
  overwriting another's listing via catalog import.
- **Oversized/hostile values.** Redaction bounds string length, depth, and
  sibling counts before classification, so pathological payloads cannot stall
  the pipeline.

## Verification

```bash
cd server
npx vitest run src/tests/promptImportPipeline.test.ts
```
