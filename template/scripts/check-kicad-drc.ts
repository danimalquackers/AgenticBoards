import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parses a JSON report produced by `kicad-cli pcb drc --format json` and exits
 * non-zero if any DRC error or unconnected net is present.
 */
const reportPath = resolve(process.cwd(), process.argv[2] ?? "dist/exports/kicad-drc.json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const errors = (report.violations ?? []).filter((v: any) => v.severity === "error");
const unconnected = report.unconnected_items ?? [];
const total = errors.length + unconnected.length;

console.log(
  `[KICAD-DRC] ${total === 0 ? "PASS" : "FAIL"} (${errors.length} error(s), ${unconnected.length} unconnected net(s))`,
);

for (const v of errors) {
  console.error(`  [ERROR] ${v.type ?? "drc"}: ${v.description ?? JSON.stringify(v)}`);
}
for (const u of unconnected) {
  console.error(`  [UNCONNECTED] ${u.description ?? JSON.stringify(u)}`);
}

if (total > 0) process.exit(1);
