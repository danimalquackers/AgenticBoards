import * as tscChecks from "@tscircuit/checks"
import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map"
import type { BoardSpec } from "../specs/board-spec.schema"
import type { CheckFinding } from "./types"

/**
 * Runs native Circuit JSON error extraction and `@tscircuit/checks` DRC suites.
 */
export function runDrcChecks(circuitJson: any[], spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = []

  // 1. Collect built-in errors & warnings emitted during tscircuit evaluation/routing
  for (const el of circuitJson) {
    const type = String(el?.type ?? "")
    if (type.endsWith("_error") || el?.error_type) {
      findings.push({
        id: `drc.native.${el.error_type ?? type}`,
        category: "drc",
        severity: "error",
        message: el.message ?? `Circuit JSON error: ${type}`,
        details: { type, errorType: el.error_type },
      })
    } else if (type.endsWith("_warning") || el?.warning_type) {
      findings.push({
        id: `drc.native.${el.warning_type ?? type}`,
        category: "drc",
        severity: "warning",
        message: el.message ?? `Circuit JSON warning: ${type}`,
        details: { type, warningType: el.warning_type },
      })
    }
  }

  // 2. Run modular @tscircuit/checks validators available in the installed version
  const connMap = getFullConnectivityMapFromCircuitJson(circuitJson)
  const checkNames = [
    "checkEachPcbTraceNonOverlapping",
    "checkPcbComponentsOutOfBoard",
    "checkEachPcbPortConnectedToPcbTrace",
    "checkSameNetViaSpacing",
    "checkDifferentNetViaSpacing",
    "checkPcbTracesOutOfBoard",
    "checkCourtyardOverlap",
    "checkDifferentNetTraceClearance",
  ] as const

  const checksMod = tscChecks as Record<string, unknown>

  for (const fnName of checkNames) {
    const fn = checksMod[fnName]
    if (typeof fn !== "function") continue

    try {
      const results = fn(circuitJson, {
        connMap,
        minClearance: spec.fabRules.minClearanceMm,
      })
      if (!Array.isArray(results)) continue

      for (const issue of results) {
        const isWarn = String(issue?.type ?? "").includes("warning")
        findings.push({
          id: `drc.${fnName}`,
          category: "drc",
          severity: isWarn ? "warning" : "error",
          message: issue?.message ?? `${fnName} reported an issue`,
          details: issue,
        })
      }
    } catch (err) {
      findings.push({
        id: `drc.${fnName}.exception`,
        category: "drc",
        severity: "warning",
        message: `Skipped ${fnName}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return findings
}
