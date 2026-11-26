import { basename, resolve } from "node:path";
import { writeJson } from "../checks/circuit-index";
import { loadSpec } from "../checks/index";
import { resolveNetClassRules } from "../checks/net-rules";

/**
 * Generates a KiCad `.kicad_pro` file whose design rules, Default netclass,
 * and per-net/power-rail netclasses match `specs/board.spec.json`.
 * `kicad-cli pcb drc` automatically reads a sibling `.kicad_pro` when checking `board.kicad_pcb`.
 */
const outPath = resolve(process.cwd(), process.argv[2] ?? "dist/exports/board.kicad_pro");
const spec = loadSpec("specs/board.spec.json");
const fab = spec.fabRules;

const viaAnnularMm = Number(
  Math.max(0.05, (fab.minViaDiameterMm - fab.minViaDrillMm) / 2).toFixed(4),
);

interface KicadNetClass {
  clearance: number;
  name: string;
  track_width: number;
  via_diameter: number;
  via_drill: number;
  diff_pair_gap?: number;
  diff_pair_width?: number;
}

const classes: KicadNetClass[] = [
  {
    clearance: fab.minClearanceMm,
    name: "Default",
    track_width: fab.minTraceWidthMm,
    via_diameter: fab.minViaDiameterMm,
    via_drill: fab.minViaDrillMm,
  },
];

const netclassAssignments: Record<string, string> = {};

for (const nc of resolveNetClassRules(spec)) {
  const entry: KicadNetClass = {
    clearance: nc.clearanceMm,
    name: nc.name,
    track_width: nc.trackWidthMm,
    via_diameter: nc.viaDiameterMm,
    via_drill: nc.viaDrillMm,
  };
  if (nc.diffPairGapMm !== undefined) {
    entry.diff_pair_gap = nc.diffPairGapMm;
    entry.diff_pair_width = nc.trackWidthMm;
  }
  classes.push(entry);
  for (const net of nc.nets) {
    netclassAssignments[net] = nc.name;
  }
}

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
  net_settings: {
    classes,
    ...(Object.keys(netclassAssignments).length > 0
      ? { netclass_assignments: netclassAssignments }
      : {}),
  },
  meta: {
    filename: basename(outPath),
    version: 1,
  },
};

writeJson(outPath, kicadProject);
console.log(
  `[KICAD] Synced ${fab.fabHouse} design rules (${classes.length} netclass(es)) -> ${outPath}`,
);
