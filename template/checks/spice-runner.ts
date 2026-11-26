import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoardSpec } from "../specs/board-spec.schema";
import { isDirectRun, readJson, writeJson } from "./circuit-index";
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
  error?: string;
  assertionResults: SimulationAssertionResult[];
}

export type SimulationExecutor = (
  simFile: string,
  rootDir: string,
) => { status: number | null; stdout: string; stderr: string; error?: Error };

function matchesProbeHeader(col: string, needle: string): boolean {
  const norm = col.trim().toLowerCase();
  if (!norm) return false;
  if (norm === needle) return true;
  // Match SPICE probe notation like v(vout) or v(net.vout) without matching v1 inside v10.
  const wrapped = norm.match(/^[vi]\((.+)\)$/);
  if (wrapped) {
    const inner = wrapped[1].trim();
    return inner === needle || inner.endsWith(`.${needle}`);
  }
  return false;
}

export function parseProbeValues(output: string, probe: string): number[] {
  const needle = probe.trim().toLowerCase();
  if (!needle) return [];

  const lines = output.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    const sep = trimmed.includes(",") ? "," : /\s+/;
    const cols = trimmed.split(sep);
    const colIdx = cols.findIndex((c) => matchesProbeHeader(c, needle));
    if (colIdx < 0) continue;

    const values: number[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j].trim();
      if (!row) continue;

      const cells = row.split(sep);
      const rawCell = cells[colIdx]?.trim();
      if (!rawCell) continue;

      const v = Number(rawCell);
      if (Number.isFinite(v)) values.push(v);
    }

    if (values.length > 0) return values;
  }

  return [];
}

export function computeMetric(values: number[], metric: string): number | null {
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

export function evaluateAssertion(
  stdout: string,
  assertion: AssertionSpec,
): SimulationAssertionResult {
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

const defaultExecutor: SimulationExecutor = (simFile, rootDir) => {
  const proc = spawnSync("tscircuit-cli", ["simulate", simFile], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    error: proc.error,
  };
};

export function runSingleSimulation(
  sim: SimulationSpec,
  rootDir: string,
  executor: SimulationExecutor = defaultExecutor,
): SimulationRunResult {
  const simFile = resolve(rootDir, sim.file);
  const proc = executor(simFile, rootDir);
  const errorMsg = proc.error?.message;
  const assertionResults = errorMsg
    ? []
    : sim.assertions.map((a) => evaluateAssertion(proc.stdout, a));

  return {
    name: sim.name,
    file: sim.file,
    engine: sim.engine,
    passed: !errorMsg && proc.status === 0 && assertionResults.every((r) => r.passed),
    stdout: proc.stdout,
    stderr: errorMsg ? `${errorMsg}\n${proc.stderr}`.trim() : proc.stderr,
    ...(errorMsg ? { error: errorMsg } : {}),
    assertionResults,
  };
}

function computeSimCacheKey(spec: BoardSpec, rootDir: string): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(spec.simulations));

  for (const sim of spec.simulations) {
    const simFile = resolve(rootDir, sim.file);
    hash.update(sim.file);
    if (existsSync(simFile)) hash.update(readFileSync(simFile));
  }

  return hash.digest("hex");
}

export function runSimulations(
  spec: BoardSpec,
  rootDir = process.cwd(),
  executor: SimulationExecutor = defaultExecutor,
): SimulationRunResult[] {
  const reportPath = resolve(rootDir, "dist/sim-report.json");
  const cachePath = resolve(rootDir, "dist/sim-cache.json");
  const cacheKey = computeSimCacheKey(spec, rootDir);

  if (process.env.FORCE_SIM !== "1" && existsSync(reportPath) && existsSync(cachePath)) {
    try {
      const cached = readJson<{ cacheKey?: string }>(cachePath);
      if (cached.cacheKey === cacheKey) {
        return readJson<SimulationRunResult[]>(reportPath);
      }
    } catch {
      // Cache unreadable; fall through to re-run simulations.
    }
  }

  const results = spec.simulations.map((sim) => runSingleSimulation(sim, rootDir, executor));
  writeJson(reportPath, results);
  writeJson(cachePath, { cacheKey });
  return results;
}

if (isDirectRun(import.meta.url)) {
  const spec = loadSpec();
  const results = runSimulations(spec);

  for (const r of results) {
    console.log(`[SIM] ${r.name} (${r.engine}): ${r.passed ? "PASS" : "FAIL"}`);
    if (r.error) console.log(`  - ERROR: ${r.error}`);
    for (const a of r.assertionResults) {
      console.log(`  - ${a.passed ? "OK" : "FAIL"}: ${a.message}`);
    }
  }

  if (results.some((r) => !r.passed)) process.exit(1);
}
