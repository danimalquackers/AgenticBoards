import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { loadSpec } from "../checks/index"
import { runSimulations } from "../checks/spice-runner"

/**
 * SPICE Electrical Simulation Verification Suite.
 *
 * Runs every simulation defined in `specs/board.spec.json` under `simulations[]`
 * via `tsci simulate analog` (ngspice/spicey) and verifies voltage/ripple bounds.
 */
describe("Electrical SPICE Simulations", () => {
  const spec = loadSpec("specs/board.spec.json")

  if (spec.simulations.length === 0) {
    test("no simulations declared in specs/board.spec.json", () => {
      assert.deepEqual(spec.simulations, [])
    })
    return
  }

  test("all declared SPICE simulations pass their probe assertions", () => {
    const results = runSimulations(spec)
    for (const sim of results) {
      const failures = sim.assertionResults.filter((a) => !a.passed).map((a) => a.message)
      assert.deepEqual(
        { name: sim.name, passed: sim.passed, failures },
        { name: sim.name, passed: true, failures: [] },
      )
    }
  })
})
