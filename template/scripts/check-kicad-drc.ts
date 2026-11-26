import { resolve } from "node:path";
import { parseKicadDrcReport } from "../checks/circuit-index";

/**
 * Parses a JSON report produced by `kicad-cli pcb drc --format json` and exits
 * non-zero if any DRC error or unconnected net is present.
 */
const reportPath = resolve(process.cwd(), process.argv[2] ?? "dist/exports/kicad-drc.json");
const summary = parseKicadDrcReport(reportPath);

if (!summary) {
  console.error(`[KICAD-DRC] Report not found: ${reportPath}`);
  process.exit(1);
}

console.log(
  `[KICAD-DRC] ${summary.passed ? "PASS" : "FAIL"} ` +
    `(${summary.errorCount} error(s), ${summary.unconnectedCount} unconnected net(s), ${summary.warningCount} warning(s))`,
);

for (const v of summary.errors) {
  console.error(`  [ERROR] ${v.type ?? "drc"}: ${v.description ?? JSON.stringify(v)}`);
}
for (const u of summary.unconnected) {
  console.error(`  [UNCONNECTED] ${u.description ?? JSON.stringify(u)}`);
}

if (!summary.passed) process.exit(1);
