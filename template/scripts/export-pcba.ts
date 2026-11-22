import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { convertCircuitJsonToPickAndPlaceCsv } from "circuit-json-to-pnp-csv";
import { indexCircuit } from "../checks/circuit-index";
import { compileBoard, loadSpec } from "../checks/index";

/**
 * Generates JLCPCB-compatible BOM CSV and Pick-and-Place CPL CSV into `dist/exports/`.
 */
const outDir = resolve(process.cwd(), "dist/exports");
mkdirSync(outDir, { recursive: true });

const spec = loadSpec("specs/board.spec.json");
const circuitJson = await compileBoard(spec.entrypoint);
const idx = indexCircuit(circuitJson);

const csvRow = (cols: unknown[]) =>
  cols.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",");

const bomRows = ["Comment,Designator,Footprint,LCSC Part #,MPN,UnitCostUSD,Notes"];
for (const sc of idx.sourceComponents) {
  const name = String(sc.name ?? "");
  const cost = spec.budget.bomCosts[name];
  const lcsc = cost?.lcsc ?? sc.supplier_part_numbers?.jlcpcb?.[0] ?? "";
  const comment = sc.display_resistance ?? sc.display_capacitance ?? cost?.mpn ?? sc.ftype ?? name;
  const footprint = idx.pcbBySourceId.get(sc.source_component_id)?.footprint_name ?? "";
  bomRows.push(csvRow([comment, name, footprint, lcsc, cost?.mpn, cost?.unitCostUsd, cost?.notes]));
}

writeFileSync(resolve(outDir, "bom.csv"), `${bomRows.join("\n")}\n`);
writeFileSync(resolve(outDir, "pnp.csv"), convertCircuitJsonToPickAndPlaceCsv(circuitJson));
console.log("[PCBA] Wrote dist/exports/bom.csv and dist/exports/pnp.csv");
