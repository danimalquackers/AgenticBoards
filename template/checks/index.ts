import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { Circuit } from "tscircuit";
import { type BoardSpec, BoardSpecSchema } from "../specs/board-spec.schema";
import { indexCircuit, isDirectRun, writeJson } from "./circuit-index";
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
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), specPath), "utf8"));
  return BoardSpecSchema.parse(raw);
}

const DEFAULT_COMPILE_TIMEOUT_MS = 180_000;

export async function compileBoard(entrypoint: string): Promise<any[]> {
  const modPath = resolve(process.cwd(), entrypoint);
  const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
  const Component = mod.default ?? mod.MainBoard;

  if (typeof Component !== "function") {
    throw new Error(`Entrypoint ${entrypoint} must default-export a React component function.`);
  }

  const timeoutMs = Number(process.env.AUTOROUTE_TIMEOUT_MS ?? DEFAULT_COMPILE_TIMEOUT_MS);
  const circuit = new Circuit();
  circuit.add(React.createElement(Component));

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
      return JSON.parse(readFileSync(cachedPath, "utf8")) as any[];
    }
  }

  return compileBoard(entrypoint);
}

export async function runAllBoardChecks(specPath = "specs/board.spec.json"): Promise<CheckReport> {
  const spec = loadSpec(specPath);
  const circuitJson = await compileBoard(spec.entrypoint);
  const idx = indexCircuit(circuitJson);

  const drcFindings = runDrcChecks(idx, spec);
  const { findings: constraintFindings, bom, boardMetrics } = runConstraintChecks(idx, spec);
  const elecFindings = runElectricalHeuristics(idx, spec);

  const findings = [...drcFindings, ...constraintFindings, ...elecFindings];
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  const report: CheckReport = {
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

  writeJson(resolve(process.cwd(), "dist/circuit.json"), circuitJson);
  writeJson(resolve(process.cwd(), "dist/checks-report.json"), report);

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

async function main(): Promise<void> {
  let report: CheckReport;

  if (process.argv.includes("--summary")) {
    const reportPath = resolve(process.cwd(), "dist/checks-report.json");
    if (!existsSync(reportPath)) {
      console.error("No dist/checks-report.json found. Run `just check` or `just test` first.");
      process.exit(1);
    }
    report = JSON.parse(readFileSync(reportPath, "utf8")) as CheckReport;
  } else {
    report = await runAllBoardChecks();
  }

  printReport(report);
  if (!report.passed) process.exit(1);
}

if (isDirectRun(import.meta.url)) {
  await main();
}
