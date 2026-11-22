import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { formatFindingSummary, loadSpec, runAllBoardChecks } from "../checks/index";
import type { CheckCategory, CheckReport } from "../checks/types";

/**
 * Test-Driven PCB Constraint & Verification Suite (Node built-in test runner).
 *
 * Workflow:
 *   1. Clarify requirements, then encode them in `specs/board.spec.json` and
 *      custom `test(...)` cases below BEFORE writing circuit code.
 *   2. Run `just test` and confirm the new constraints fail first.
 *   3. Implement or refactor modular subcircuits in `src/`.
 *   4. Iterate until every test passes with zero DRC, spec, or electrical errors.
 */

let report: CheckReport;

function assertNoErrors(...categories: CheckCategory[]): void {
  const allowed = new Set(categories);
  const errs = report.findings.filter((f) => f.severity === "error" && allowed.has(f.category));
  assert.equal(errs.length, 0, `\n${formatFindingSummary(errs)}`);
}

before(async () => {
  report = await runAllBoardChecks("specs/board.spec.json");
});

describe("Board Specification & TDD Contract", () => {
  test("specs/board.spec.json conforms to BoardSpecSchema", () => {
    const spec = loadSpec("specs/board.spec.json");
    assert.ok(spec.projectName.length > 0);
    assert.ok(spec.dimensions.maxWidthMm > 0);
    assert.ok(spec.dimensions.maxHeightMm > 0);
  });

  test("DRC: zero native, @tscircuit/checks, or unrouted-trace errors", () => {
    assertNoErrors("drc");
  });

  test("Mechanical: dimensions, layers, mounting holes, and keepouts pass", () => {
    assertNoErrors("mechanical");
  });

  test("Fab rules: traces, vias, edge clearances, and footprints satisfy fab minimums", () => {
    assertNoErrors("fab");
  });

  test("Budget: all parts priced and within BOM/unit cost ceiling", () => {
    assertNoErrors("budget");
    assert.ok(report.bom.bomCostUsd <= report.bom.maxBomUsd);
  });

  test("Electrical, Power Integrity, Signal Integrity, and Thermal: zero errors", () => {
    assertNoErrors("electrical", "power-integrity", "signal-integrity", "thermal");
  });
});
