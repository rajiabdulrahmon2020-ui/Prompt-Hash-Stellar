# Configuration contract tests

`src/test/configContract.test.ts` (run by `yarn test`) fails when production-critical configuration is missing or inconsistent. It reads the real files in the repo, so a bad edit to a template, workflow, or env read fails CI before it reaches a deploy.

## What the contract enforces

| Area | Rule |
|------|------|
| Network name | `PUBLIC_STELLAR_NETWORK` is one of `PUBLIC`, `TESTNET`, `FUTURENET`, `LOCAL` (`STANDALONE` deprecated). `MAINNET` is rejected: the frontend zod schema would throw at load. Both frontend schemas (`src/lib/env.ts`, `src/contracts/util.ts`) must list the same names. |
| Passphrase | Must equal the Stellar SDK passphrase for the chosen network, in every template, block, and `environments.toml` section. |
| Endpoints | RPC and Horizon use `https` and their hostnames imply the same network as `PUBLIC_STELLAR_NETWORK`. Workflow `env:` blocks obey the same rule. |
| Native XLM contract | `PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID` equals the Stellar Asset Contract ID derived from the network passphrase (the testnet ID must never appear in the mainnet template). `--xlm` constructor args in `environments.toml` are the testnet ID. |
| Required variables | Every name in `REQUIRED_ENV` (`scripts/contributor-diagnostics.mjs`) exists in `.env.example` and `env.mainnet.example`. The mainnet template adds no variable `.env.example` does not document. |
| Secrets | `env.mainnet.example` cannot pass validation unedited: contract ID, simulation account, unlock keys, and challenge secret are all recognized placeholders. Once replaced, it validates cleanly. |
| Undocumented reads | Every `process.env.X` in `api/` and `src/lib/`, and every `import.meta.env.PUBLIC_*` in `src/`, appears in a template. No `SECRET`/`PRIVATE`/`TOKEN`/`WEBHOOK` name is readable from browser code. |
| Docker | `docker-compose.yml` testnet defaults equal the `.env.example` testnet profile. |
| Runtime | In production, `getServerDeploymentManifest()` throws if any chain-critical variable is missing, if the network name is invalid, or if the passphrase belongs to another network. `validateUnlockSecrets()` throws on missing or placeholder secrets. The manifest hash changes when any chain-critical setting changes. |

## Failure modes

| Failing test | Meaning | Fix |
|--------------|---------|-----|
| `uses a network name the frontend accepts` | Template uses a name like `MAINNET` | Use `PUBLIC` |
| `pairs the network with its own passphrase` | Copy-paste from another network's block | Copy the block's passphrase from `.env.example` |
| `points RPC and Horizon at the same network` | Half-switched environment, or a provider URL with a neutral hostname | Use a provider hostname that names the network, or extend `classifyUrl` in `scripts/contributor-diagnostics.mjs` |
| `native XLM contract ID is the real SAC` | Wrong network's SAC pasted | Derive it: `Asset.native().contractId(passphrase)` |
| `every server-side env var is documented` | New `process.env.X` with no template entry | Add `# X=` with a comment to `.env.example` |
| `legacy aliases are only read next to their canonical name` | Legacy fallback spread to new code | Read the canonical `PUBLIC_STELLAR_*` name |
| `fails when X is missing` (runtime) | Validator lost a production check | Restore the check in `src/lib/validation/envValidator.ts` |

When adding a new production-critical variable: add it to `.env.example` and `env.mainnet.example`, to `REQUIRED_ENV` if the app cannot run without it, and to `docs/environments.md`.

## Operational edge cases

- **Existing deployments using `MAINNET`**: the frontend already crashed on this value, so no working deploy depends on it. The server now rejects it in production as well; change the variable to `PUBLIC`.
- **Server rollout**: the new production checks run only when `NODE_ENV` or `VERCEL_ENV` is `production`. A mismatched passphrase makes `/api/readiness` return `503` with the reason; check it after deploy.
- **Legacy variable names**: `api/prompts/version.ts` used to read `PUBLIC_NATIVE_ASSET_CONTRACT_ID` and `PUBLIC_SIMULATION_ACCOUNT`, which no template defined, so they resolved to empty strings. It now reads the canonical names first and keeps the old names as a fallback.
- **`REACT_APP_API_URL`** (`promptHashClient.ts`) is a known undocumented legacy read; it is allow-listed in the test and should be replaced, not extended.
- **Self-hosted RPC with a neutral hostname** is not classified; the live check in `yarn diagnose` (`getNetwork` passphrase probe) still catches a mismatch.
- **Placeholders**: values starting with `your-`/`your_` or ending in `_here` count as placeholders in the unlock service, `check:setup`, and `yarn diagnose`.

## Rollback and recovery

The changes are validation only; no data or contract state is touched.

- If a production deploy starts returning `503` from `/api/readiness`, read the `error` field, fix the named variable in the hosting dashboard, and redeploy. To restore service immediately, redeploy the previous release; the stricter checks live only in `envValidator.ts`.
- If the contract tests block an urgent change, fix the config rather than the test. Relaxing a rule requires updating this document and the test in the same commit.
- Tests do not need network access or secrets; they run in `yarn test` and CI.

See also: `docs/environments.md`, `docs/operations/contributor-diagnostics.md`, `docs/secret-rotation.md`.
