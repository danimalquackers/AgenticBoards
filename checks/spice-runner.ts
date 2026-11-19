import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type BoardSpec, BoardSpecSchema } from "../specs/board-spec.schema"

export interface SimulationRunResult {
  name: string
  file: string
  engine: string
  passed: boolean
  stdout: string
  stderr: string
  assertionResults: Array<{
    probe: string
    metric: string
    actual: number | null
    min?: number
    max?: number
    passed: boolean
    message: string
  }>
}

function parseProbeValues(output: string, probe: string): number[] {
  const values: number[] = []
  const lines = output.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => l.includes(probe))
  if (headerIdx >= 0) {
    const sep = lines[headerIdx].includes(",") ? "," : /\s+/
    const cols = lines[headerIdx].trim().split(sep)
    const colIdx = cols.findIndex((c) => c.trim().toLowerCase().includes(probe.toLowerCase()))
    if (colIdx >= 0) {
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(sep)
        const v = Number(parts[colIdx])
        if (Number.isFinite(v)) values.push(v)
      }
    }
  }
  return values
}

function computeMetric(values: number[], metric: string): number | null {
  if (values.length === 0) return null
  if (metric === "min") return Math.min(...values)
  if (metric === "max") return Math.max(...values)
  if (metric === "final") return values[values.length - 1]
  if (metric === "avg") return values.reduce((a, b) => a + b, 0) / values.length
  if (metric === "ripple") {
    const tail = values.slice(Math.floor(values.length * 0.5))
    return Math.max(...tail) - Math.min(...tail)
  }
  return null
}

export function runSimulations(spec: BoardSpec, rootDir = process.cwd()): SimulationRunResult[] {
  const results: SimulationRunResult[] = []

  for (const sim of spec.simulations) {
    const simFile = resolve(rootDir, sim.file)
    const proc = spawnSync("tsci", ["simulate", "analog", simFile, sim.engine], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 60_000,
    })

    const stdout = proc.stdout ?? ""
    const stderr = proc.stderr ?? ""
    const ok = proc.status === 0
    const assertionResults = sim.assertions.map((a) => {
      const samples = parseProbeValues(stdout, a.probe)
      const actual = computeMetric(samples, a.metric)
      if (actual === null) {
        return {
          probe: a.probe,
          metric: a.metric,
          actual: null,
          min: a.min,
          max: a.max,
          passed: false,
          message: `Probe ${a.probe} not found in simulation output`,
        }
      }
      const minOk = a.min === undefined || actual >= a.min
      const maxOk = a.max === undefined || actual <= a.max
      const passed = minOk && maxOk
      return {
        probe: a.probe,
        metric: a.metric,
        actual: Number(actual.toFixed(4)),
        min: a.min,
        max: a.max,
        passed,
        message: `${a.probe}.${a.metric} = ${actual.toFixed(4)}${a.unit} (expected [${a.min ?? "-inf"}, ${a.max ?? "+inf"}])`,
      }
    })

    results.push({
      name: sim.name,
      file: sim.file,
      engine: sim.engine,
      passed: ok && assertionResults.every((r) => r.passed),
      stdout,
      stderr,
      assertionResults,
    })
  }

  mkdirSync(resolve(rootDir, "dist"), { recursive: true })
  writeFileSync(resolve(rootDir, "dist/sim-report.json"), JSON.stringify(results, null, 2))
  return results
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const spec = BoardSpecSchema.parse(JSON.parse(readFileSync("specs/board.spec.json", "utf8")))
  const results = runSimulations(spec)
  for (const r of results) {
    console.log(`[SIM] ${r.name} (${r.engine}): ${r.passed ? "PASS" : "FAIL"}`)
    for (const a of r.assertionResults) {
      console.log(`  - ${a.passed ? "PASS" : "FAIL"}: ${a.message}`)
    }
    if (!r.passed && r.stderr) console.error(r.stderr)
  }
  if (results.some((r) => !r.passed)) process.exit(1)
}
