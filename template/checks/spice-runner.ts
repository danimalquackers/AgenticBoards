import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { BoardSpec } from "../specs/board-spec.schema";
import { isDirectRun, writeJson } from "./circuit-index";
import { loadSpec } from "./index";

type SimulationSpec = BoardSpec["simulations"][number];
type AssertionSpec = SimulationSpec["assertions"][number];

export interface SimulationAssertionResult {
  probe: string;
  metric: string;
  actual: number | null;
  min?: number;
  max?: number;
  passed: boolean;
  message: string;
}

export interface SimulationRunResult {
  name: string;
  file: string;
  engine: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  assertionResults: SimulationAssertionResult[];
}

function parseProbeValues(output: string, probe: string): number[] {
  const needle = probe.toLowerCase();
  const lines = output.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => line.toLowerCase().includes(needle));
  if (headerIdx < 0) return [];

  const sep = lines[headerIdx].includes(",") ? "," : /\s+/;
  const cols = lines[headerIdx].trim().split(sep);
  const colIdx = cols.findIndex((col) => col.trim().toLowerCase().includes(needle));
  if (colIdx < 0) return [];

  const values: number[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const v = Number(lines[i].trim().split(sep)[colIdx]);
    if (Number.isFinite(v)) values.push(v);
  }

  return values;
}

function computeMetric(values: number[], metric: string): number | null {
  if (values.length === 0) return null;

  switch (metric) {
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "final":
      return values[values.length - 1];
    case "avg":
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    case "ripple": {
      const tail = values.slice(Math.floor(values.length * 0.5));
      return Math.max(...tail) - Math.min(...tail);
    }
    default:
      return null;
  }
}

function evaluateAssertion(stdout: string, assertion: AssertionSpec): SimulationAssertionResult {
  const samples = parseProbeValues(stdout, assertion.probe);
  const actual = computeMetric(samples, assertion.metric);

  if (actual === null) {
    return {
      probe: assertion.probe,
      metric: assertion.metric,
      actual: null,
      min: assertion.min,
      max: assertion.max,
      passed: false,
      message: `Probe ${assertion.probe} not found in simulation output`,
    };
  }

  const minOk = assertion.min === undefined || actual >= assertion.min;
  const maxOk = assertion.max === undefined || actual <= assertion.max;
  const bounds = `[${assertion.min ?? "-inf"}, ${assertion.max ?? "+inf"}]`;

  return {
    probe: assertion.probe,
    metric: assertion.metric,
    actual: Number(actual.toFixed(4)),
    min: assertion.min,
    max: assertion.max,
    passed: minOk && maxOk,
    message: `${assertion.probe}.${assertion.metric} = ${actual.toFixed(4)}${assertion.unit} (expected ${bounds})`,
  };
}

function runSingleSimulation(sim: SimulationSpec, rootDir: string): SimulationRunResult {
  const simFile = resolve(rootDir, sim.file);
  const proc = spawnSync("tscircuit-cli", ["simulate", simFile], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 60_000,
  });

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  const assertionResults = sim.assertions.map((a) => evaluateAssertion(stdout, a));

  return {
    name: sim.name,
    file: sim.file,
    engine: sim.engine,
    passed: proc.status === 0 && assertionResults.every((r) => r.passed),
    stdout,
    stderr,
    assertionResults,
  };
}

export function runSimulations(spec: BoardSpec, rootDir = process.cwd()): SimulationRunResult[] {
  const results = spec.simulations.map((sim) => runSingleSimulation(sim, rootDir));
  writeJson(resolve(rootDir, "dist/sim-report.json"), results);
  return results;
}

if (isDirectRun(import.meta.url)) {
  const spec = loadSpec();
  const results = runSimulations(spec);

  for (const r of results) {
    console.log(`[SIM] ${r.name} (${r.engine}): ${r.passed ? "PASS" : "FAIL"}`);
    for (const a of r.assertionResults) {
      console.log(`  - ${a.passed ? "OK" : "FAIL"}: ${a.message}`);
    }
  }

  if (results.some((r) => !r.passed)) process.exit(1);
}
