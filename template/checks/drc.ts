import * as tscChecks from "@tscircuit/checks";
import type { BoardSpec } from "../specs/board-spec.schema";
import { type CircuitIndex, error, warn } from "./circuit-index";
import type { CheckFinding } from "./types";

const DRC_VALIDATORS = [
  "checkEachPcbTraceNonOverlapping",
  "checkPcbComponentsOutOfBoard",
  "checkEachPcbPortConnectedToPcbTrace",
  "checkSameNetViaSpacing",
  "checkDifferentNetViaSpacing",
  "checkPcbTracesOutOfBoard",
  "checkCourtyardOverlap",
  "checkDifferentNetTraceClearance",
] as const;

function extractNativeFindings(raw: any[]): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const el of raw) {
    const type = String(el?.type ?? "");

    if (type.endsWith("_error") || el?.error_type) {
      findings.push(
        error(
          "drc",
          `drc.native.${el.error_type ?? type}`,
          el.message ?? `Circuit JSON error: ${type}`,
          { type, errorType: el.error_type },
        ),
      );
    } else if (type.endsWith("_warning") || el?.warning_type) {
      findings.push(
        warn(
          "drc",
          `drc.native.${el.warning_type ?? type}`,
          el.message ?? `Circuit JSON warning: ${type}`,
          { type, warningType: el.warning_type },
        ),
      );
    }
  }

  return findings;
}

function runTscircuitValidators(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const checksMod = tscChecks as Record<string, unknown>;
  const options = {
    connMap: idx.connMap,
    minClearance: spec.fabRules.minClearanceMm,
  };

  for (const fnName of DRC_VALIDATORS) {
    const validator = checksMod[fnName];
    if (typeof validator !== "function") continue;

    try {
      const results = validator(idx.raw, options);
      if (!Array.isArray(results)) continue;

      for (const issue of results) {
        const isWarn = String(issue?.type ?? "").includes("warning");
        const emit = isWarn ? warn : error;
        findings.push(
          emit("drc", `drc.${fnName}`, issue?.message ?? `${fnName} reported an issue`, issue),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push(warn("drc", `drc.${fnName}.exception`, `Skipped ${fnName}: ${message}`));
    }
  }

  return findings;
}

/** Runs native Circuit JSON error extraction and `@tscircuit/checks` DRC suites. */
export function runDrcChecks(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  return [...extractNativeFindings(idx.raw), ...runTscircuitValidators(idx, spec)];
}
