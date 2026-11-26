import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { Circuit } from "tscircuit";
import { type BoardSpec, BoardSpecSchema } from "../specs/board-spec.schema";
import {
  indexCircuit,
  isDirectRun,
  parseKicadDrcReport,
  readJson,
  writeJson,
} from "./circuit-index";
import { runConstraintChecks } from "./constraints";
import { runDrcChecks } from "./drc";
import { runElectricalHeuristics } from "./electrical-heuristics";
import type { CheckFinding, CheckReport, FindingSummary } from "./types";

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function summarizeFindings(findings: CheckFinding[], maxSamples = 3): FindingSummary[] {
  const groups = new Map<string, FindingSummary>();

  for (const f of findings) {
    const key = `${f.severity}:${f.category}:${f.id}`;
    const existing = groups.get(key);

    if (existing) {
      existing.count += 1;
      if (existing.samples.length < maxSamples) existing.samples.push(f.message);
      continue;
    }

    groups.set(key, {
      id: f.id,
      category: f.category,
      severity: f.severity,
      count: 1,
      samples: [f.message],
    });
  }

  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.count - a.count ||
      a.id.localeCompare(b.id),
  );
}

export function formatFindingSummary(findings: CheckFinding[], maxSamples = 3): string {
  return summarizeFindings(findings, maxSamples)
    .map((group) => {
      const header = `[${group.severity.toUpperCase()}] (${group.category}) ${group.id} x${group.count}`;
      const lines = group.samples.map((sample) => `    - ${sample}`);

      if (group.count > group.samples.length) {
        lines.push(`    - ... (${group.count - group.samples.length} more)`);
      }

      return `${header}\n${lines.join("\n")}`;
    })
    .join("\n");
}

export function loadSpec(specPath = "specs/board.spec.json"): BoardSpec {
  const fullPath = resolve(process.cwd(), specPath);
  const raw = readJson(fullPath);
  return BoardSpecSchema.parse(raw);
}

const DEFAULT_COMPILE_TIMEOUT_MS = 180_000;

function resolveCompileTimeoutMs(): number {
  const raw = process.env.AUTOROUTE_TIMEOUT_MS;
  if (!raw || raw.trim() === "") return DEFAULT_COMPILE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COMPILE_TIMEOUT_MS;
}

export async function compileBoard(
  entrypoint: string,
  options: { routingDisabled?: boolean } = {},
): Promise<any[]> {
  const modPath = resolve(process.cwd(), entrypoint);
  const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const Component = mod.default ?? mod.MainBoard;

  if (typeof Component !== "function") {
    throw new Error(`Entrypoint ${entrypoint} must default-export a React component function.`);
  }

  const timeoutMs = resolveCompileTimeoutMs();
  const circuit = new Circuit();
  let element: React.ReactElement;

  if (options.routingDisabled) {
    const rendered = Component();
    element = React.isValidElement(rendered)
      ? React.cloneElement(rendered as React.ReactElement<Record<string, unknown>>, {
          routingDisabled: true,
        })
      : React.createElement(Component);
  } else {
    element = React.createElement(Component);
  }

  circuit.add(element);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      circuit.renderUntilSettled(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Board compile/autoroute timed out after ${Math.round(timeoutMs / 1000)}s. ` +
                "Check for `<copperpour unbroken />` blocking an inner routing layer or overly tight clearances (override via AUTOROUTE_TIMEOUT_MS).",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return circuit.getCircuitJson();
}

function newestMtimeMs(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;

  let latest = st.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    latest = Math.max(latest, newestMtimeMs(resolve(path, entry.name)));
  }
  return latest;
}

/** Reuses `dist/circuit.json` when newer than `src/` and `specs/`, otherwise compiles the board. */
export async function loadOrCompileCircuit(entrypoint: string): Promise<any[]> {
  const cachedPath = resolve(process.cwd(), "dist/circuit.json");
  if (existsSync(cachedPath)) {
    const cachedMtime = statSync(cachedPath).mtimeMs;
    const latestSource = Math.max(
      newestMtimeMs(resolve(process.cwd(), "src")),
      newestMtimeMs(resolve(process.cwd(), "specs")),
    );
    if (cachedMtime >= latestSource) {
      return readJson<any[]>(cachedPath);
    }
  }

  const circuitJson = await compileBoard(entrypoint);
  writeJson(cachedPath, circuitJson);
  return circuitJson;
}

const ROUTING_ONLY_DRC_IDS = new Set([
  "drc.native.pcb_port_not_connected_error",
  "drc.native.pcb_trace_missing_error",
  "drc.checkEachPcbPortConnectedToPcbTrace",
]);

/** Pure check runner over compiled Circuit JSON (no compilation or disk writes). */
export function runChecksOnCircuitJson(
  circuitJson: any[],
  spec: BoardSpec,
  options: { placementOnly?: boolean } = {},
): CheckReport {
  const placementOnly = Boolean(options.placementOnly);
  const idx = indexCircuit(circuitJson);

  const drcFindings = runDrcChecks(idx, spec);
  const {
    findings: constraintFindings,
    bom,
    boardMetrics,
  } = runConstraintChecks(idx, spec, { placementOnly });
  const elecFindings = runElectricalHeuristics(idx, spec, { placementOnly });

  const rawFindings = [...drcFindings, ...constraintFindings, ...elecFindings];
  const findings = placementOnly
    ? rawFindings.filter((f) => !ROUTING_ONLY_DRC_IDS.has(f.id))
    : rawFindings;

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  return {
    timestamp: new Date().toISOString(),
    projectName: spec.projectName,
    entrypoint: spec.entrypoint,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    boardMetrics,
    bom,
    summary: summarizeFindings(findings),
    findings,
  };
}

export async function runAllBoardChecks(
  specPath = "specs/board.spec.json",
  options: { placementOnly?: boolean } = {},
): Promise<CheckReport> {
  const placementOnly = Boolean(options.placementOnly);
  const spec = loadSpec(specPath);
  const circuitJson = await compileBoard(spec.entrypoint, { routingDisabled: placementOnly });
  const report = runChecksOnCircuitJson(circuitJson, spec, { placementOnly });

  if (!placementOnly) {
    writeJson(resolve(process.cwd(), "dist/circuit.json"), circuitJson);
    writeJson(resolve(process.cwd(), "dist/checks-report.json"), report);
  }

  return report;
}

function printReport(report: CheckReport): void {
  const { boardMetrics: m, bom } = report;

  console.log(`\n=== PCB Verification Report: ${report.projectName} ===`);
  console.log(
    `Board: ${m.widthMm ?? "?"}x${m.heightMm ?? "?"}mm | ${m.layers ?? "?"}L | ` +
      `${m.componentCount} parts | ${m.traceCount} traces | ${m.viaCount} vias`,
  );
  console.log(
    `Budget: BOM $${bom.bomCostUsd.toFixed(2)} / $${bom.maxBomUsd.toFixed(2)} | ` +
      `Unit Est $${bom.totalUnitCostUsd.toFixed(2)}`,
  );
  console.log(
    `Status: ${report.passed ? "PASS" : "FAIL"} (${report.errorCount} errors, ${report.warningCount} warnings)\n`,
  );

  if (report.findings.length > 0) {
    console.log(formatFindingSummary(report.findings));
  }
}

function readKicadDrcSnapshot() {
  try {
    const summary = parseKicadDrcReport(resolve(process.cwd(), "dist/exports/kicad-drc.json"));
    if (!summary) return null;
    return {
      present: summary.present,
      passed: summary.passed,
      errorCount: summary.errorCount,
      unconnectedCount: summary.unconnectedCount,
      warningCount: summary.warningCount,
    };
  } catch (err) {
    return {
      present: true,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");
  const placementOnly = process.argv.includes("--placement");
  let report: CheckReport;

  if (process.argv.includes("--summary")) {
    const reportPath = resolve(process.cwd(), "dist/checks-report.json");
    if (!existsSync(reportPath)) {
      console.error("No dist/checks-report.json found. Run `just check` or `just test` first.");
      process.exit(1);
    }
    report = readJson<CheckReport>(reportPath);
  } else {
    report = await runAllBoardChecks("specs/board.spec.json", { placementOnly });
  }

  if (jsonMode) {
    const snapshot = {
      timestamp: report.timestamp,
      projectName: report.projectName,
      placementOnly,
      passed: report.passed,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      boardMetrics: report.boardMetrics,
      bom: {
        bomCostUsd: report.bom.bomCostUsd,
        maxBomUsd: report.bom.maxBomUsd,
        totalUnitCostUsd: report.bom.totalUnitCostUsd,
        unpricedCount: report.bom.unpricedDesignators.length,
      },
      kicadDrc: readKicadDrcSnapshot(),
      summary: report.summary,
    };
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printReport(report);
  }

  if (!report.passed) process.exit(1);
}

if (isDirectRun(import.meta.url)) {
  await main();
}
