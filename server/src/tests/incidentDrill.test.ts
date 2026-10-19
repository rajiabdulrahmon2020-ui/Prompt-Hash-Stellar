/**
 * Tests for Incident Drill Service (Issue #972)
 *
 * Verifies that:
 *  - The drill runner exposes all required steps.
 *  - Each step produces a structured DrillStepResult.
 *  - The full drill report aggregates results correctly.
 *  - Secret-redaction and dependency-matrix structural checks pass in isolation.
 *  - A failed step doesn't crash the runner.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { IncidentDrillRunner, type DrillReport } from "../services/incidentDrillService.js";

const DRILL_ENV = {
  apiBaseUrl: "http://localhost:9999",   // Nothing listening here — expected to fail
  timeoutMs: 200,
};

const EXPECTED_STEP_IDS = [
  "A1_health_endpoint",
  "A2_readiness_endpoint",
  "A3_status_endpoint",
  "B1_dependency_probes_importable",
  "B2_fallback_matrix_failure_modes",
  "C1_structured_logger_redacts_secrets",
  "C2_operational_health_service_importable",
  "C3_disaster_recovery_validator_importable",
  "D1_sanitize_sensitive_data_function",
];

describe("IncidentDrillRunner — structure (Issue #972)", () => {
  it("exposes all required drill step IDs", () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const ids = runner.getSteps().map((s) => s.id);
    for (const expected of EXPECTED_STEP_IDS) {
      expect(ids).toContain(expected);
    }
  });

  it("every step has a non-empty title and description", () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    for (const step of runner.getSteps()) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("every step belongs to a valid category", () => {
    const valid = new Set(["A_visibility", "B_settlement", "C_operational", "D_auth"]);
    const runner = new IncidentDrillRunner(DRILL_ENV);
    for (const step of runner.getSteps()) {
      expect(valid.has(step.category)).toBe(true);
    }
  });
});

describe("IncidentDrillRunner — runStep (Issue #972)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runStep returns null for an unknown step id", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("nonexistent_step");
    expect(result).toBeNull();
  });

  it("C1 step passes: structuredLogger redacts sensitive fields correctly", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("C1_structured_logger_redacts_secrets");
    expect(result).not.toBeNull();
    expect(result!.stepId).toBe("C1_structured_logger_redacts_secrets");
    expect(result!.status).toBe("pass");
  });

  it("C2 step passes: operationalHealthService is importable", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("C2_operational_health_service_importable");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("pass");
    expect(result!.evidence).toContain("generateHealthReport");
  });

  it("C3 step passes: disasterRecoveryValidationService exposes all invariant methods", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("C3_disaster_recovery_validator_importable");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("pass");
    expect(result!.evidence).toContain("invariant check methods");
  });

  it("D1 step passes: sanitizeSensitiveData strips secrets correctly", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("D1_sanitize_sensitive_data_function");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("pass");
  });

  it("B1 step passes: dependency degradation matrix is importable with all entries", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("B1_dependency_probes_importable");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("pass");
    expect(result!.evidence).toContain("stellar_rpc");
    expect(result!.evidence).toContain("mongodb");
  });

  it("B2 step passes: all degradation matrix entries have complete failure modes", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("B2_fallback_matrix_failure_modes");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("pass");
  });

  it("A1 step fails gracefully when API base URL is unreachable", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const result = await runner.runStep("A1_health_endpoint");
    expect(result).not.toBeNull();
    // Should fail since nothing is running on port 9999, but must not throw
    expect(result!.stepId).toBe("A1_health_endpoint");
    expect(result!.status).toBe("fail");
    expect(result!.evidence).toBeTruthy();
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("IncidentDrillRunner — runFullDrill (Issue #972)", () => {
  it("report has correct shape", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const report: DrillReport = await runner.runFullDrill();

    expect(report.drillId).toMatch(/^drill_\d+$/);
    expect(report.startedAt).toBeTruthy();
    expect(report.completedAt).toBeTruthy();
    expect(typeof report.passed).toBe("boolean");
    expect(report.results).toHaveLength(EXPECTED_STEP_IDS.length);
    expect(report.passedCount + report.failedCount + report.skippedCount).toBe(report.totalSteps);
    expect(report.failures.length).toBe(report.failedCount);
  });

  it("failures array matches failedCount", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const report = await runner.runFullDrill();
    expect(report.failures).toHaveLength(report.failedCount);
  });

  it("userImpactSummary has one entry per failed step", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const report = await runner.runFullDrill();
    expect(report.userImpactSummary).toHaveLength(report.failedCount);
  });

  it("passed=false when HTTP steps fail (API unreachable)", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const report = await runner.runFullDrill();
    // A1/A2/A3 all reach localhost:9999 which is not running
    expect(report.passed).toBe(false);
    const httpStepIds = ["A1_health_endpoint", "A2_readiness_endpoint", "A3_status_endpoint"];
    const httpFails = report.failures.filter((f) => httpStepIds.includes(f.stepId));
    expect(httpFails.length).toBeGreaterThan(0);
  });

  it("non-HTTP steps (C1/C2/C3/D1/B1/B2) all pass regardless of API availability", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const report = await runner.runFullDrill();
    const moduleCheckIds = [
      "B1_dependency_probes_importable",
      "B2_fallback_matrix_failure_modes",
      "C1_structured_logger_redacts_secrets",
      "C2_operational_health_service_importable",
      "C3_disaster_recovery_validator_importable",
      "D1_sanitize_sensitive_data_function",
    ];
    for (const id of moduleCheckIds) {
      const result = report.results.find((r) => r.stepId === id);
      expect(result).toBeDefined();
      expect(result!.status).toBe("pass");
    }
  });

  it("each result includes durationMs", async () => {
    const runner = new IncidentDrillRunner(DRILL_ENV);
    const report = await runner.runFullDrill();
    for (const result of report.results) {
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
