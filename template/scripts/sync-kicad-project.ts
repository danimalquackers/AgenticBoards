import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadSpec } from "../checks/index";

/**
 * Generates a KiCad `.kicad_pro` file whose design rules match `specs/board.spec.json -> fabRules`.
 * `kicad-cli pcb drc` automatically reads a sibling `.kicad_pro` when checking `board.kicad_pcb`.
 */
const outPath = resolve(process.cwd(), process.argv[2] ?? "dist/exports/board.kicad_pro");
const spec = loadSpec("specs/board.spec.json");
const fab = spec.fabRules;

const viaAnnularMm = Number(
  Math.max(0.05, (fab.minViaDiameterMm - fab.minViaDrillMm) / 2).toFixed(4),
);

const kicadProject = {
  board: {
    design_settings: {
      rules: {
        min_clearance: fab.minClearanceMm,
        min_copper_edge_clearance: fab.minEdgeClearanceMm,
        min_hole_clearance: fab.minClearanceMm,
        min_hole_to_hole: fab.minClearanceMm,
        min_silk_clearance: 0.1,
        min_text_height: 0.5,
        min_text_thickness: 0.1,
        min_through_hole_diameter: fab.minViaDrillMm,
        min_track_width: fab.minTraceWidthMm,
        min_via_annular_width: viaAnnularMm,
        min_via_diameter: fab.minViaDiameterMm,
      },
    },
  },
  meta: {
    filename: "board.kicad_pro",
    version: 1,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(kicadProject, null, 2)}\n`);
console.log(`[KICAD] Synced ${fab.fabHouse} design rules -> ${outPath}`);
