# Threat Model: Cross-Boundary Trust Decisions (#963)

This document models the places where PromptHash Stellar decides whether to
trust input that came from the other side of a boundary. Each abuse case is
listed with its mitigation and the test or check that enforces it. The
highest-risk path found while building this model, a forged wallet session,
is fixed in this change and has a regression test (TM-1).

## Assets

| Asset | Why it matters |
|---|---|
| Prompt plaintext | The product. Released only by `api/prompts/unlock.ts`. |
| Buyer entitlements | `has_access` on the Soroban contract decides who may unlock. |
| Wallet identity | Wallet sessions gate the buyer library, provenance declarations, and identity links. |
| Settlement funds | XLM moves on-chain in `buy_prompt` and bundle/pass purchases. |
| `CHALLENGE_TOKEN_SECRET`, `ADMIN_TOKEN_SECRET`, `UNLOCK_PRIVATE_KEY` | Forging tokens or unwrapping prompt keys requires these. |
| Audit trail | The hash-chained evidence used for disputes and support. |

## Trust boundaries

```
 Browser + wallet ──TB1──▶ Public API (api/*) ──TB2──▶ Soroban RPC / Horizon
                              │      ▲
                              │      └──TB4── server-owned token flows (shared secret)
                              ├──TB3──▶ IPFS gateway (ciphertext)
 Operator ──TB5──▶ Express server (server/src) ──TB6──▶ outbound webhooks
 Any account ──TB7──▶ Soroban contract (host-enforced auth)
```

| ID | Boundary | Untrusted side | Trust decision |
|---|---|---|---|
| TB1 | Browser/wallet to public API | Everything in the request | Is this wallet the signer, for this prompt, now? |
| TB2 | API to Soroban RPC | RPC responses, ledger freshness | Has this wallet paid, according to a current ledger? |
| TB3 | API to IPFS | Ciphertext bytes | Is this the content the creator listed? |
| TB4 | Public challenge issuer vs. server-owned token flows | Request body fields chosen by the caller | Which token types may a public caller obtain? |
| TB5 | Operator to server | Bearer token | Is this an admin with the needed scope? |
| TB6 | Server to outbound URLs | Creator-supplied webhook URLs | May the server connect to this host? |
| TB7 | Callers to the contract | Transaction arguments | Did the address authorize this call? |

## Abuse cases

Severity is about impact if the mitigation failed. "Verified by" names the
test or check that fails if the mitigation regresses.

| ID | Abuse case | Boundary | Severity | Mitigation | Verified by |
|---|---|---|---|---|---|
| TM-1 | Mint a wallet-session token for someone else's wallet by asking the public issuer for `action: "wallet_session"` | TB4 | Critical | The public issuer signs only actions in `PUBLIC_CHALLENGE_ACTIONS` (`unlock`). Refusals are audited as `challenge_issued` / `blocked` / `unsupported_action`. **Fixed in this change.** | `api/auth/challenge.test.ts` |
| TM-2 | Replay a signed unlock request | TB1 | High | One-time nonce in a shared store, plus token and signature replay checks | `api/prompts/unlock.test.ts` ("rejects a replayed request") |
| TM-3 | Use another wallet's challenge, or sign with the wrong key | TB1 | High | Token is bound to the address and the ed25519 signature is verified against it | `src/lib/auth/challenge.test.ts` ("wrong wallet address", "signature from a different wallet") |
| TM-4 | Reuse a token across prompt, network, contract, origin, or action | TB1 | High | Token payload binds each one, and `verifyChallengeToken` checks it | `src/lib/auth/challenge.test.ts` (wrong prompt ID; origin/network/contract/action mismatch table) |
| TM-5 | Unlock after the listing changed (price or owner drift) | TB1 | Medium | Listing snapshot hash bound into the signed challenge | `api/prompts/unlock.test.ts` (#698 suite) |
| TM-6 | Unlock without paying, or against a lagging or wrong-network RPC | TB2 | Critical | On-chain `has_access`, ledger-age bound, network check; fails closed on RPC errors | `api/prompts/unlock.test.ts` (#545 suite) |
| TM-7 | Serve tampered ciphertext from IPFS | TB3 | High | Plaintext hash is recomputed and compared with the on-chain content hash before release | `api/prompts/unlock.test.ts` ("recomputed hash does not match") |
| TM-8 | Forge or over-scope an admin token | TB5 | Critical | HMAC with a separate `ADMIN_TOKEN_SECRET`; audience, expiry, revocation, and per-route scope; fails closed when unconfigured | `server/src/tests/adminAuth.test.ts` |
| TM-9 | Register a webhook for another creator's wallet | TB1 | Medium | Wallet-signed challenge with a consumed nonce | `api/webhooks/index.test.ts` |
| TM-10 | Make the server call internal hosts through a webhook URL (SSRF) | TB6 | High | `ssrfGuard` blocks private, loopback, and metadata ranges | `server/src/tests/ssrfGuard.test.ts` |
| TM-11 | Call a contract mutation as another address | TB7 | Critical | `require_auth` is enforced by the Soroban host, including signature and nonce replay protection | `contracts/prompt-hash/src/test.rs` (`cargo test -p prompt-hash`) |
| TM-12 | Learn internal hosts or secrets from the public status page | TB1 | Medium | Public status keeps reason codes only (#986) | `server/src/tests/publicStatus.test.ts`, `api/status.test.ts` |
| TM-13 | Leak buyer PII or URLs through a support evidence bundle | TB5 | Medium | Wallets hashed, free text digested, IPs excluded (#967) | `server/src/tests/supportEvidenceBundle.test.ts` |
| TM-14 | Evade per-IP rate limits by spoofing `X-Forwarded-For` | TB1 | Low | On Vercel the platform overwrites `X-Forwarded-For` to prevent spoofing. Per-wallet limits still apply. | Deployment check (see edge cases) |

### TM-1 in detail (fixed)

All challenge-style tokens share one format and one key,
`CHALLENGE_TOKEN_SECRET`. Verifiers tell them apart by `promptId` (subject)
and `action`:

| Token | Issuer | Verifier needs a wallet signature? |
|---|---|---|
| Unlock challenge (`unlock`) | `POST /api/auth/challenge` (public) | Yes |
| Wallet sign-in, webhook proof | `POST /api/auth/challenge` (public) | Yes |
| Wallet-session challenge (`wallet_session_challenge`) | `GET /api/wallet-session/challenge` | Yes |
| **Wallet session (`wallet_session`)** | `POST /api/wallet-session`, after a signature | **No: it is a bearer token** |
| Identity link (`external_identity_link`) | Server, behind a wallet session | Yes |

Before this change, the public issuer copied `action` from the request body.
A request like `{"address":"<victim>","promptId":"wallet-session","action":"wallet_session"}`
returned a token that `requireWalletSession` accepted as a 5-minute session for
the victim, with no signature. That session opened the victim's buyer library,
provenance declarations, and identity-link endpoints.

The fix is default-deny at the issuer. Only `unlock` is signed, which is the
default every first-party client already uses: `src/lib/prompts/unlock.ts` and
`src/lib/auth/walletAuth.ts` never send `action`. A token the issuer still
mints carries `action: "unlock"`, which the session gate rejects even when the
caller picks the session subject as `promptId`. The regression test checks both.

## Operational edge cases and failure modes

- **A new public action is needed.** Add it to `PUBLIC_CHALLENGE_ACTIONS`
  only if every verifier that accepts it also requires a wallet signature.
  Never add `wallet_session`, or any action whose token is used as a bearer
  credential.
- **Clients that sent other actions.** They now get
  `400 CHALLENGE_INVALID: Unsupported challenge action.` No first-party
  client does this. Third-party callers should omit `action`.
- **Self-hosting the API off Vercel.** Put it behind a proxy that overwrites
  `X-Forwarded-For` (TM-14). Otherwise per-IP limits can be bypassed and only
  per-wallet limits remain.
- **Shared-store outage.** The nonce ledger fails closed in production, so
  unlocks are refused rather than becoming replayable (TM-2).
- **RPC outage.** Unlock fails closed (TM-6), and `/api/status` reports the
  dependency as down (#986).

## Detection and incident response for TM-1

1. Find past attempts. Legitimate clients never request a challenge for the
   session subject, so any issued challenge with `promptId=wallet-session`
   is suspicious:
   `GET /api/audit/export?action=challenge_issued&promptId=wallet-session`
   (scope `audit:export`). After this change, refusals also appear as
   `challenge_issued` with `result=blocked` and `reason=unsupported_action`.
2. If exploitation is suspected, rotate `CHALLENGE_TOKEN_SECRET`
   ([secret-rotation.md](secret-rotation.md)). Wallet sessions are verified
   only against the current secret, so rotation ends every outstanding
   session at once. Users re-sign to get a new session.
3. Review identity links and provenance declarations created during the
   exposure window for the affected wallets.

## Rollback

Reverting the allowlist reopens TM-1, so do not roll it back on its own. If a
legitimate integration breaks, add its action to the allowlist under the rule
above and redeploy. The change has no data migration and no schema change.

## Residual risks and follow-ups

- **One key for every token purpose.** Deriving a per-purpose key (for example
  HKDF over `CHALLENGE_TOKEN_SECRET` with the action as context) would make
  cross-purpose minting impossible even if an issuer regressed. That change
  invalidates outstanding tokens and needs a rotation plan, so it is out of
  scope for this slice.
- **Lenient optional context.** `verifyChallengeToken` skips the
  origin/network/contract check when the token carries `*` or an empty value.
  The public issuer always sets network and contract, so the unlock path is
  bound, but server-issued tokens rely on action and subject only.
