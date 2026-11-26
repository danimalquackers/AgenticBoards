import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ipc2221MinTraceWidthMm } from "../checks/electrical-heuristics";
import { loadSpec } from "../checks/index";

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

for (const nc of spec.netClasses ?? []) {
  const entry: KicadNetClass = {
    clearance: nc.clearanceMm ?? fab.minClearanceMm,
    name: nc.name,
    track_width: nc.trackWidthMm ?? fab.minTraceWidthMm,
    via_diameter: nc.viaDiameterMm ?? fab.minViaDiameterMm,
    via_drill: nc.viaDrillMm ?? fab.minViaDrillMm,
  };
  if (nc.diffPairGapMm) {
    entry.diff_pair_gap = nc.diffPairGapMm;
    entry.diff_pair_width = nc.trackWidthMm ?? fab.minTraceWidthMm;
  }
  classes.push(entry);
  for (const net of nc.nets) {
    netclassAssignments[net] = nc.name;
  }
}

for (const rail of spec.powerRails) {
  if (netclassAssignments[rail.net]) continue;

  const reqWidthMm = Math.max(
    ipc2221MinTraceWidthMm(
      rail.maxCurrentA,
      spec.electrical.maxTraceTempRiseC,
      spec.dimensions.copperWeightOz,
    ),
    rail.minTraceWidthMm ?? 0,
  );
  const reqClearanceMm = Math.max(fab.minClearanceMm, rail.minClearanceMm ?? 0);

  if (reqWidthMm <= fab.minTraceWidthMm + 1e-3 && reqClearanceMm <= fab.minClearanceMm + 1e-3) {
    continue;
  }

  const className = `rail_${rail.net}`;
  classes.push({
    clearance: Number(reqClearanceMm.toFixed(4)),
    name: className,
    track_width: Number(Math.max(fab.minTraceWidthMm, reqWidthMm).toFixed(4)),
    via_diameter: fab.minViaDiameterMm,
    via_drill: fab.minViaDrillMm,
  });
  netclassAssignments[rail.net] = className;
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
    filename: "board.kicad_pro",
    version: 1,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(kicadProject, null, 2)}\n`);
console.log(
  `[KICAD] Synced ${fab.fabHouse} design rules (${classes.length} netclass(es)) -> ${outPath}`,
);
