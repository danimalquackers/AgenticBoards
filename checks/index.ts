import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import React from "react"
import { Circuit } from "tscircuit"
import { type BoardSpec, BoardSpecSchema } from "../specs/board-spec.schema"
import { runConstraintChecks } from "./constraints"
import { runDrcChecks } from "./drc"
import { runElectricalHeuristics } from "./electrical-heuristics"
import type { CheckReport } from "./types"

export function loadSpec(specPath = "specs/board.spec.json"): BoardSpec {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), specPath), "utf8"))
  return BoardSpecSchema.parse(raw)
}

export async function compileBoard(entrypoint: string): Promise<any[]> {
  const modPath = resolve(process.cwd(), entrypoint)
  const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`)
  const Component = mod.default ?? mod.MainBoard
  if (typeof Component !== "function") {
    throw new Error(`Entrypoint ${entrypoint} must default-export a React component function.`)
  }
  const circuit = new Circuit()
  circuit.add(React.createElement(Component))
  await circuit.renderUntilSettled()
  return circuit.getCircuitJson()
}

export async function runAllBoardChecks(specPath = "specs/board.spec.json"): Promise<CheckReport> {
  const spec = loadSpec(specPath)
  const circuitJson = await compileBoard(spec.entrypoint)

  const drcFindings = runDrcChecks(circuitJson, spec)
  const { findings: constraintFindings, bom, boardMetrics } = runConstraintChecks(circuitJson, spec)
  const elecFindings = runElectricalHeuristics(circuitJson, spec)

  const findings = [...drcFindings, ...constraintFindings, ...elecFindings]
  const errorCount = findings.filter((f) => f.severity === "error").length
  const warningCount = findings.filter((f) => f.severity === "warning").length

  const report: CheckReport = {
    timestamp: new Date().toISOString(),
    projectName: spec.projectName,
    entrypoint: spec.entrypoint,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    boardMetrics,
    bom,
    findings,
  }

  mkdirSync(resolve(process.cwd(), "dist"), { recursive: true })
  writeFileSync(resolve(process.cwd(), "dist/circuit.json"), JSON.stringify(circuitJson, null, 2))
  writeFileSync(resolve(process.cwd(), "dist/checks-report.json"), JSON.stringify(report, null, 2))

  return report
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const report = await runAllBoardChecks()
  console.log(`\n=== PCB Verification Report: ${report.projectName} ===`)
  console.log(
    `Board: ${report.boardMetrics.widthMm ?? "?"}x${report.boardMetrics.heightMm ?? "?"}mm | ` +
      `${report.boardMetrics.layers ?? "?"}L | ${report.boardMetrics.componentCount} parts | ` +
      `${report.boardMetrics.traceCount} traces | ${report.boardMetrics.viaCount} vias`,
  )
  console.log(
    `Budget: BOM $${report.bom.bomCostUsd.toFixed(2)} / $${report.bom.maxBomUsd.toFixed(2)} | ` +
      `Unit Est $${report.bom.totalUnitCostUsd.toFixed(2)}`,
  )
  console.log(
    `Status: ${report.passed ? "PASS" : "FAIL"} (${report.errorCount} errors, ${report.warningCount} warnings)\n`,
  )
  for (const f of report.findings) {
    console.log(`[${f.severity.toUpperCase()}] (${f.category}) ${f.id}: ${f.message}`)
  }
  if (!report.passed) process.exit(1)
}
