import assert from "node:assert/strict"
import { before, describe, test } from "node:test"
import { loadSpec, runAllBoardChecks } from "../checks/index"
import type { CheckReport } from "../checks/types"

/**
 * TDD PCB Constraint & Verification Suite (Node built-in test runner).
 *
 * Workflow:
 *   1. Update `specs/board.spec.json` and add project-specific tests below FIRST.
 *   2. Run `npm test` to observe failing (red) constraints.
 *   3. Implement or refactor the board in `src/boards/` and `src/subcircuits/`.
 *   4. Iterate until ALL tests pass (green) with zero DRC/spec/electrical errors.
 */

let report: CheckReport

before(async () => {
  report = await runAllBoardChecks("specs/board.spec.json")
})

describe("Board Specification & TDD Contract", () => {
  test("specs/board.spec.json conforms to BoardSpecSchema", () => {
    const spec = loadSpec("specs/board.spec.json")
    assert.ok(spec.projectName.length > 0)
    assert.ok(spec.dimensions.maxWidthMm > 0)
    assert.ok(spec.dimensions.maxHeightMm > 0)
  })

  test("DRC: zero native or @tscircuit/checks errors", () => {
    const errors = report.findings.filter((f) => f.category === "drc" && f.severity === "error")
    assert.deepEqual(errors, [])
  })

  test("Mechanical: dimensions, layers, mounting holes, and keepouts pass", () => {
    const errors = report.findings.filter(
      (f) => f.category === "mechanical" && f.severity === "error",
    )
    assert.deepEqual(errors, [])
  })

  test("Fab rules: trace widths, vias, and footprints satisfy fab house minimums", () => {
    const errors = report.findings.filter((f) => f.category === "fab" && f.severity === "error")
    assert.deepEqual(errors, [])
  })

  test("Budget: BOM and total unit cost remain within target ceiling", () => {
    const errors = report.findings.filter((f) => f.category === "budget" && f.severity === "error")
    assert.deepEqual(errors, [])
    assert.ok(report.bom.bomCostUsd <= report.bom.maxBomUsd)
  })

  test("Electrical, Power Integrity, Signal Integrity, and Thermal: zero errors", () => {
    const categories = new Set(["electrical", "power-integrity", "signal-integrity", "thermal"])
    const errors = report.findings.filter(
      (f) => categories.has(f.category) && f.severity === "error",
    )
    assert.deepEqual(errors, [])
  })
})
