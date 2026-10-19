# Incident Drill Runbook

> **Issue**: #972  
> **Purpose**: A runbook backed by executable verification checks that prove recovery, rollback,
> data validation, and user-impact reporting steps actually work.

---

## Overview

This runbook describes how to run a full incident drill against the Prompt Hash Stellar system.
Each drill step maps to a section of the [INCIDENT_RUNBOOK.md](./INCIDENT_RUNBOOK.md) and is
backed by an executable check that produces a pass/fail result with evidence.

**Drill runner**: `server/src/services/incidentDrillService.ts`  
**Tests**: `server/src/tests/incidentDrill.test.ts`

---

## Running the Drill

### Via the test suite (recommended in CI)

```bash
cd server
yarn test --run src/tests/incidentDrill.test.ts
```

### Programmatically

```typescript
import { IncidentDrillRunner } from "./services/incidentDrillService";

const runner = new IncidentDrillRunner({ apiBaseUrl: "http://localhost:5000" });
const report = await runner.runFullDrill();

console.log("Passed:", report.passed);
console.log("Failures:", report.userImpactSummary);
```

### Run a single step

```typescript
const result = await runner.runStep("C1_structured_logger_redacts_secrets");
console.log(result.status, result.evidence);
```

---

## Drill Steps

### Category A — Data Visibility & Search

| Step ID | Title | What it proves |
|---|---|---|
| `A1_health_endpoint` | Health endpoint responds with 200 | `/api/health` is reachable after deployment or incident. |
| `A2_readiness_endpoint` | Readiness endpoint confirms service is ready | Load balancer probe target responds; instance is in rotation. |
| `A3_status_endpoint` | Status endpoint reports multi-service state | `/api/status` returns parseable JSON listing sub-service health. |

**Runbook mapping**: Category A, Step 1 — "Run the appropriate diagnostics command."

---

### Category B — Contract & Settlement

| Step ID | Title | What it proves |
|---|---|---|
| `B1_dependency_probes_importable` | Dependency degradation matrix importable | Operator tooling for checking third-party health is intact. |
| `B2_fallback_matrix_failure_modes` | All dependencies have complete failure modes | No gaps in degradation matrix that would leave operators without guidance. |

**Runbook mapping**: Category B — "Verify contract state / Check settlement queue."

---

### Category C — Operational

| Step ID | Title | What it proves |
|---|---|---|
| `C1_structured_logger_redacts_secrets` | Logger redacts sensitive fields | Wallet addresses, private keys, tokens do not leak into log aggregators. |
| `C2_operational_health_service_importable` | Operational health service loads | Dashboard tooling is usable post-deployment/rollback. |
| `C3_disaster_recovery_validator_importable` | DR validation service exposes all invariant checks | All 7 invariant check methods are present and callable during rollback. |

**Runbook mapping**: Category C — "Health check / Database connection pool."

---

### Category D — Authentication & Authorization

| Step ID | Title | What it proves |
|---|---|---|
| `D1_sanitize_sensitive_data_function` | sanitizeSensitiveData strips Stellar keys and tokens | Health dashboard does not expose credentials to operators. |

**Runbook mapping**: Category D — "Verify auth keys."

---

## Drill Report Structure

```typescript
interface DrillReport {
  drillId: string;              // e.g. "drill_1727996400000"
  startedAt: string;            // ISO timestamp
  completedAt: string;
  passed: boolean;              // false if any step fails
  totalSteps: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  results: DrillStepResult[];
  failures: DrillStepResult[];  // only failed steps
  userImpactSummary: string[];  // human-readable impact per failure
}
```

---

## Recovery Verification After Incident

After applying a fix during or after an incident, re-run the drill to confirm recovery:

```bash
# 1. Fix the root cause
# 2. Re-run relevant drill steps
yarn test --run src/tests/incidentDrill.test.ts

# 3. Check API endpoints are live
curl http://localhost:5000/api/health
curl http://localhost:5000/api/status

# 4. Confirm data integrity
yarn data:integrity:monitor

# 5. Confirm dependency probes are green
# (Run runDegradationMatrixProbes() in a node REPL or integration test)
```

All steps in categories B, C, and D are module-level checks that pass without a running API
server. Steps A1–A3 require the API to be running.

---

## Operational Edge Cases

| Scenario | Drill Behavior | Operator Action |
|---|---|---|
| API server not running | A1/A2/A3 fail; B/C/D steps pass | Start the server and re-run the drill. |
| `dependencyDegradationMatrix.ts` deleted | B1 fails | Re-add the file; check git history. |
| Logger redaction misconfigured | C1 fails — **CRITICAL** | Roll back logging changes immediately; audit recent log output. |
| DR validator missing a method | C3 fails | Re-add the missing method; run DR validation tests. |
| `sanitizeSensitiveData` weakened | D1 fails — **CRITICAL** | Roll back immediately; audit any health dashboard output since the change. |

---

## Scheduling Drills

Run drills as part of:
- **Pre-deployment checks**: `yarn test:incident-drill` in CI pipeline before merging to main.
- **Monthly incident readiness review**: Schedule `runner.runFullDrill()` as a cron job; alert on
  `passed === false`.
- **Post-incident validation**: Run immediately after declaring resolution.

---

## Rollback Steps

If a drill reveals failures after a deployment:

```bash
# 1. Identify last passing tag
git tag -l --sort=-version:refname | head -5

# 2. Roll back to it
git checkout -b rollback-<current-tag> <last-passing-tag>

# 3. Re-run drill to confirm rollback resolves failures
yarn test --run src/tests/incidentDrill.test.ts

# 4. Deploy rollback branch (follow DEPLOYMENT.md)
# 5. Post-mortem within 48 hours (see INCIDENT_RUNBOOK.md section 7)
```
