import type { BoardSpec } from "../specs/board-spec.schema";
import {
  type CircuitIndex,
  error,
  getKeepoutBox,
  isTestPoint,
  keepoutMatchesLayer,
  routeSegments,
  segmentIntersectsBox,
  WIDTH_EPSILON_MM,
  warn,
} from "./circuit-index";
import type { BoardMetrics, BomSummary, CheckFinding } from "./types";

export interface ConstraintCheckOutput {
  findings: CheckFinding[];
  bom: BomSummary;
  boardMetrics: BoardMetrics;
}

interface BoardGeometry {
  widthMm: number | null;
  heightMm: number | null;
  layers: number | null;
  centerX: number;
  centerY: number;
}

function getBoardGeometry(idx: CircuitIndex): BoardGeometry {
  const b = idx.pcbBoard;

  return {
    widthMm: typeof b?.width === "number" ? b.width : null,
    heightMm: typeof b?.height === "number" ? b.height : null,
    layers: typeof b?.num_layers === "number" ? b.num_layers : null,
    centerX: typeof b?.center?.x === "number" ? b.center.x : 0,
    centerY: typeof b?.center?.y === "number" ? b.center.y : 0,
  };
}

function createEdgeChecker(geom: BoardGeometry, minEdgeClearanceMm: number) {
  const limitX =
    geom.widthMm !== null ? geom.widthMm / 2 - minEdgeClearanceMm : Number.POSITIVE_INFINITY;
  const limitY =
    geom.heightMm !== null ? geom.heightMm / 2 - minEdgeClearanceMm : Number.POSITIVE_INFINITY;

  return (x: unknown, y: unknown, radius: number): boolean => {
    if (typeof x !== "number" || typeof y !== "number") return false;

    const exceedsX = Math.abs(x - geom.centerX) + radius > limitX + 1e-3;
    const exceedsY = Math.abs(y - geom.centerY) + radius > limitY + 1e-3;
    return exceedsX || exceedsY;
  };
}

function checkDimensions(geom: BoardGeometry, idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const { widthMm, heightMm, layers } = geom;
  const { maxWidthMm, maxHeightMm, exactWidthMm, exactHeightMm, toleranceMm } = spec.dimensions;

  if (!idx.pcbBoard || widthMm === null || heightMm === null) {
    return [
      error(
        "mechanical",
        "mechanical.board.missing",
        "No pcb_board with numeric width/height found in Circuit JSON.",
      ),
    ];
  }

  const findings: CheckFinding[] = [];

  if (widthMm > maxWidthMm + toleranceMm) {
    findings.push(
      error(
        "mechanical",
        "mechanical.width.max",
        `Board width ${widthMm.toFixed(2)}mm exceeds maxWidthMm (${maxWidthMm}mm).`,
      ),
    );
  }

  if (heightMm > maxHeightMm + toleranceMm) {
    findings.push(
      error(
        "mechanical",
        "mechanical.height.max",
        `Board height ${heightMm.toFixed(2)}mm exceeds maxHeightMm (${maxHeightMm}mm).`,
      ),
    );
  }

  if (exactWidthMm !== undefined && Math.abs(widthMm - exactWidthMm) > toleranceMm) {
    findings.push(
      error(
        "mechanical",
        "mechanical.width.exact",
        `Board width ${widthMm.toFixed(2)}mm does not match exactWidthMm (${exactWidthMm}±${toleranceMm}mm).`,
      ),
    );
  }

  if (exactHeightMm !== undefined && Math.abs(heightMm - exactHeightMm) > toleranceMm) {
    findings.push(
      error(
        "mechanical",
        "mechanical.height.exact",
        `Board height ${heightMm.toFixed(2)}mm does not match exactHeightMm (${exactHeightMm}±${toleranceMm}mm).`,
      ),
    );
  }

  if (layers !== null && layers !== spec.dimensions.layers) {
    findings.push(
      error(
        "mechanical",
        "mechanical.layers.mismatch",
        `Board has ${layers} layers, but spec requires ${spec.dimensions.layers} layers.`,
      ),
    );
  }

  return findings;
}

function checkMountingHoles(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const hole of spec.mountingHoles) {
    const matched = idx.pcbHoles.some((h) => {
      const dx = Math.abs((h.x ?? 0) - hole.xMm);
      const dy = Math.abs((h.y ?? 0) - hole.yMm);
      const dd = Math.abs((h.hole_diameter ?? h.diameter ?? 0) - hole.diameterMm);
      return dx <= hole.toleranceMm && dy <= hole.toleranceMm && dd <= hole.toleranceMm;
    });

    if (!matched) {
      findings.push(
        error(
          "mechanical",
          "mechanical.mounting_hole.missing",
          `Required mounting hole ${hole.name ?? ""} at (${hole.xMm}, ${hole.yMm})mm Ø${hole.diameterMm}mm not found.`,
        ),
      );
    }
  }

  return findings;
}

export function checkKeepoutZones(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const zone of spec.keepoutZones) {
    const box = getKeepoutBox(zone);
    const boxOverlaps = (x: number, y: number, hw: number, hh: number) =>
      x + hw > box.minX && x - hw < box.maxX && y + hh > box.minY && y - hh < box.maxY;

    for (const comp of idx.pcbComponents) {
      const compLayer = typeof comp.layer === "string" ? comp.layer : "top";
      if (!keepoutMatchesLayer(zone, compLayer)) continue;

      const cx = comp.center?.x ?? 0;
      const cy = comp.center?.y ?? 0;
      if (boxOverlaps(cx, cy, (comp.width ?? 0) / 2, (comp.height ?? 0) / 2)) {
        findings.push(
          error(
            "mechanical",
            "mechanical.keepout.violation",
            `Component ${comp.source_component_id ?? comp.pcb_component_id} (${compLayer}) overlaps keepout zone "${zone.name}".`,
          ),
        );
      }
    }

    for (const via of idx.pcbVias) {
      const r = (via.outer_diameter ?? 0) / 2;
      if (
        typeof via.x === "number" &&
        typeof via.y === "number" &&
        boxOverlaps(via.x, via.y, r, r)
      ) {
        findings.push(
          error(
            "mechanical",
            "mechanical.keepout.via",
            `Via ${via.pcb_via_id} intrudes into keepout zone "${zone.name}".`,
          ),
        );
      }
    }

    for (const trace of idx.pcbTraces) {
      let violated = false;

      // Check full wire segments (catches pass-through traces whose endpoints lie outside the zone).
      for (const seg of routeSegments(trace)) {
        const layer = seg.layer ?? "top";
        if (!keepoutMatchesLayer(zone, layer)) continue;

        const r = (seg.widthMm ?? trace.trace_thickness ?? 0) / 2;
        if (segmentIntersectsBox(seg.a, seg.b, box, r)) {
          findings.push(
            error(
              "mechanical",
              "mechanical.keepout.trace",
              `Trace ${trace.pcb_trace_id} (${layer}) intrudes into keepout zone "${zone.name}".`,
            ),
          );
          violated = true;
          break;
        }
      }

      if (violated) continue;

      // Also check via points embedded in trace.route across their from_layer / to_layer.
      for (const pt of trace.route ?? []) {
        if (pt?.route_type !== "via" || typeof pt.x !== "number" || typeof pt.y !== "number") {
          continue;
        }
        const viaLayers = [pt.from_layer, pt.to_layer].filter(
          (l): l is string => typeof l === "string",
        );
        const hitsLayer =
          viaLayers.length === 0 || viaLayers.some((l) => keepoutMatchesLayer(zone, l));
        if (hitsLayer && boxOverlaps(pt.x, pt.y, 0, 0)) {
          findings.push(
            error(
              "mechanical",
              "mechanical.keepout.trace",
              `Trace ${trace.pcb_trace_id} via intrudes into keepout zone "${zone.name}".`,
            ),
          );
          break;
        }
      }
    }
  }

  return findings;
}

function collectRoutedPcbPorts(routedTraces: any[]): Set<string> {
  const portIds = new Set<string>();

  for (const trace of routedTraces) {
    if (Array.isArray(trace.connectsTo)) {
      for (const id of trace.connectsTo) {
        if (typeof id === "string") portIds.add(id);
      }
    }

    for (const seg of trace.route ?? []) {
      if (typeof seg?.start_pcb_port_id === "string") portIds.add(seg.start_pcb_port_id);
      if (typeof seg?.end_pcb_port_id === "string") portIds.add(seg.end_pcb_port_id);
    }
  }

  return portIds;
}

export function checkUnroutedTraces(idx: CircuitIndex): CheckFinding[] {
  // Skip cascade noise when placement errors already blocked autorouting.
  if (idx.hasAutoroutingError) return [];

  const routedTraces = idx.pcbTraces.filter((t) => (t.route?.length ?? 0) >= 2);
  const routedSourceTraceIds = new Set(
    routedTraces.map((t) => t.source_trace_id).filter((id): id is string => Boolean(id)),
  );
  const routedPcbPortIds = collectRoutedPcbPorts(routedTraces);

  const findings: CheckFinding[] = [];

  for (const st of idx.sourceTraces) {
    if (routedSourceTraceIds.has(st.source_trace_id)) continue;

    const sourcePortIds: string[] = Array.isArray(st.connected_source_port_ids)
      ? st.connected_source_port_ids
      : [];

    const allPortsRouted =
      sourcePortIds.length > 0 &&
      sourcePortIds.every((spId) => {
        const ppId = idx.pcbPortBySourcePortId.get(spId)?.pcb_port_id;
        return typeof ppId === "string" && routedPcbPortIds.has(ppId);
      });

    if (!allPortsRouted) {
      findings.push(
        error(
          "drc",
          "drc.unrouted_trace",
          `Source trace ${st.source_trace_id} has no routed PCB copper trace (unrouted airwire).`,
        ),
      );
    }
  }

  return findings;
}

export function checkTraceFabRules(
  idx: CircuitIndex,
  spec: BoardSpec,
  violatesEdge: (x: unknown, y: unknown, radius: number) => boolean,
): CheckFinding[] {
  const { minTraceWidthMm, minEdgeClearanceMm } = spec.fabRules;
  const findings: CheckFinding[] = [];

  for (const trace of idx.pcbTraces) {
    for (const seg of trace.route ?? []) {
      const width = typeof seg.width === "number" ? seg.width : trace.trace_thickness;
      if (typeof width === "number" && width < minTraceWidthMm - WIDTH_EPSILON_MM) {
        findings.push(
          error(
            "fab",
            "fab.trace_width.min",
            `Trace ${trace.pcb_trace_id} width ${width}mm < fab min ${minTraceWidthMm}mm.`,
          ),
        );
        break;
      }

      const halfWidth = typeof width === "number" ? width / 2 : 0;
      if (violatesEdge(seg.x, seg.y, halfWidth)) {
        findings.push(
          error(
            "fab",
            "fab.edge_clearance.trace",
            `Trace ${trace.pcb_trace_id} violates minEdgeClearanceMm (${minEdgeClearanceMm}mm) from board outline.`,
          ),
        );
        break;
      }
    }
  }

  return findings;
}

export function checkViaFabRules(
  idx: CircuitIndex,
  spec: BoardSpec,
  violatesEdge: (x: unknown, y: unknown, radius: number) => boolean,
): CheckFinding[] {
  const { minViaDrillMm, minViaDiameterMm, minEdgeClearanceMm } = spec.fabRules;
  const findings: CheckFinding[] = [];

  for (const via of idx.pcbVias) {
    if (
      typeof via.hole_diameter === "number" &&
      via.hole_diameter < minViaDrillMm - WIDTH_EPSILON_MM
    ) {
      findings.push(
        error(
          "fab",
          "fab.via_drill.min",
          `Via ${via.pcb_via_id} drill ${via.hole_diameter}mm < fab min ${minViaDrillMm}mm.`,
        ),
      );
    }

    if (
      typeof via.outer_diameter === "number" &&
      via.outer_diameter < minViaDiameterMm - WIDTH_EPSILON_MM
    ) {
      findings.push(
        error(
          "fab",
          "fab.via_diameter.min",
          `Via ${via.pcb_via_id} outer Ø ${via.outer_diameter}mm < fab min ${minViaDiameterMm}mm.`,
        ),
      );
    }

    if (violatesEdge(via.x, via.y, (via.outer_diameter ?? 0) / 2)) {
      findings.push(
        error(
          "fab",
          "fab.edge_clearance.via",
          `Via ${via.pcb_via_id} violates minEdgeClearanceMm (${minEdgeClearanceMm}mm) from board outline.`,
        ),
      );
    }
  }

  return findings;
}

function checkRequiredEntities(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const req of spec.requiredComponents) {
    const regex = req.namePattern ? new RegExp(req.namePattern) : null;
    const count = idx.sourceComponents.filter((c) => {
      const nameOk = regex ? regex.test(String(c.name ?? "")) : true;
      const ftypeOk = req.ftype ? c.ftype === req.ftype : true;
      return nameOk && ftypeOk;
    }).length;

    if (count < req.minCount) {
      findings.push(
        error(
          "electrical",
          "electrical.required_component.missing",
          `Required "${req.description}": expected >=${req.minCount}, found ${count}.`,
        ),
      );
    }
  }

  for (const reqNet of spec.requiredNets) {
    if (!idx.netByName.has(reqNet)) {
      findings.push(
        error(
          "electrical",
          "electrical.required_net.missing",
          `Required net "${reqNet}" is missing from the compiled circuit.`,
        ),
      );
    }
  }

  return findings;
}

function checkFootprintsAndModels(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];

  if (spec.electrical.requireFootprints) {
    for (const sc of idx.sourceComponents) {
      if (!idx.pcbBySourceId.has(sc.source_component_id)) {
        findings.push(
          error(
            "fab",
            "fab.footprint.missing",
            `Component ${sc.name} has no PCB footprint placed on the board.`,
          ),
        );
      }
    }
  }

  if (spec.electrical.require3dModels) {
    const cadByPcb = new Set(idx.cadModels.map((c) => c.pcb_component_id));

    for (const pc of idx.pcbComponents) {
      if (!cadByPcb.has(pc.pcb_component_id)) {
        findings.push(
          warn(
            "mechanical",
            "mechanical.3d_model.missing",
            `Component ${pc.source_component_id} has no 3D CAD model attached.`,
          ),
        );
      }
    }
  }

  return findings;
}

function evaluateBom(
  idx: CircuitIndex,
  spec: BoardSpec,
): {
  bom: BomSummary;
  findings: CheckFinding[];
} {
  let bomCostUsd = 0;
  let pricedComponents = 0;
  const unpricedDesignators: string[] = [];
  const missingPartNums: string[] = [];

  const bomComponents = idx.sourceComponents.filter((sc) => !isTestPoint(sc));

  for (const sc of bomComponents) {
    const name = String(sc.name ?? "");
    const entry = spec.budget.bomCosts[name];

    if (entry) {
      bomCostUsd += entry.unitCostUsd;
      pricedComponents += 1;
    } else {
      unpricedDesignators.push(name);
    }

    const hasPartNum = Boolean(
      entry?.lcsc || entry?.mpn || sc.supplier_part_numbers?.jlcpcb?.length,
    );
    if (!hasPartNum) missingPartNums.push(name);
  }

  const totalUnitCostUsd = bomCostUsd + spec.budget.estimatedFabUnitUsd;
  const findings: CheckFinding[] = [];

  if (unpricedDesignators.length > 0) {
    findings.push(
      error(
        "budget",
        "budget.bom.unpriced",
        `${unpricedDesignators.length} component(s) missing from specs/board.spec.json budget.bomCosts: ${unpricedDesignators.join(", ")}.`,
      ),
    );
  }

  if (missingPartNums.length > 0) {
    findings.push(
      warn(
        "fab",
        "fab.bom.missing_part_number",
        `${missingPartNums.length} component(s) lack an LCSC/MPN part number for PCBA: ${missingPartNums.join(", ")}.`,
      ),
    );
  }

  if (bomCostUsd > spec.budget.maxBomUsd) {
    findings.push(
      error(
        "budget",
        "budget.bom.exceeded",
        `BOM cost $${bomCostUsd.toFixed(2)} exceeds maxBomUsd ($${spec.budget.maxBomUsd.toFixed(2)}).`,
      ),
    );
  }

  if (spec.budget.maxTotalUnitUsd !== undefined && totalUnitCostUsd > spec.budget.maxTotalUnitUsd) {
    findings.push(
      error(
        "budget",
        "budget.total.exceeded",
        `Estimated unit cost $${totalUnitCostUsd.toFixed(2)} exceeds maxTotalUnitUsd ($${spec.budget.maxTotalUnitUsd.toFixed(2)}).`,
      ),
    );
  }

  return {
    findings,
    bom: {
      totalComponents: bomComponents.length,
      pricedComponents,
      unpricedDesignators,
      bomCostUsd: Number(bomCostUsd.toFixed(4)),
      estimatedFabUnitUsd: spec.budget.estimatedFabUnitUsd,
      totalUnitCostUsd: Number(totalUnitCostUsd.toFixed(4)),
      maxBomUsd: spec.budget.maxBomUsd,
      maxTotalUnitUsd: spec.budget.maxTotalUnitUsd,
    },
  };
}

function checkZHeights(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const { maxTopHeightMm, maxBottomHeightMm } = spec.dimensions;
  if (maxTopHeightMm === undefined && maxBottomHeightMm === undefined) return [];

  const findings: CheckFinding[] = [];

  for (const sc of idx.sourceComponents) {
    const name = String(sc.name ?? "");
    const heightMm = spec.budget.bomCosts[name]?.heightMm;
    if (heightMm === undefined) continue;

    const pcb = idx.pcbBySourceId.get(sc.source_component_id);
    const layer = typeof pcb?.layer === "string" ? pcb.layer : "top";
    const limit = layer === "bottom" ? maxBottomHeightMm : maxTopHeightMm;

    if (limit !== undefined && heightMm > limit) {
      findings.push(
        error(
          "mechanical",
          "mechanical.z_height.exceeded",
          `Component ${name} (${layer}) height ${heightMm}mm exceeds max ${layer} clearance (${limit}mm).`,
        ),
      );
    }
  }

  return findings;
}

/** Validates mechanical, fab, routing, component, net, 3D model, Z-height, and BOM budget rules. */
export function runConstraintChecks(
  idx: CircuitIndex,
  spec: BoardSpec,
  options: { placementOnly?: boolean } = {},
): ConstraintCheckOutput {
  const geom = getBoardGeometry(idx);
  const violatesEdge = createEdgeChecker(geom, spec.fabRules.minEdgeClearanceMm);
  const { bom, findings: bomFindings } = evaluateBom(idx, spec);

  const routingFindings = options.placementOnly
    ? []
    : [
        ...checkUnroutedTraces(idx),
        ...checkTraceFabRules(idx, spec, violatesEdge),
        ...checkViaFabRules(idx, spec, violatesEdge),
      ];

  const findings = [
    ...checkDimensions(geom, idx, spec),
    ...checkMountingHoles(idx, spec),
    ...checkKeepoutZones(idx, spec),
    ...checkZHeights(idx, spec),
    ...routingFindings,
    ...checkRequiredEntities(idx, spec),
    ...checkFootprintsAndModels(idx, spec),
    ...bomFindings,
  ];

  return {
    findings,
    bom,
    boardMetrics: {
      widthMm: geom.widthMm,
      heightMm: geom.heightMm,
      layers: geom.layers,
      componentCount: idx.sourceComponents.length,
      traceCount: idx.pcbTraces.length,
      viaCount: idx.pcbVias.length,
      holeCount: idx.pcbHoles.length,
      cadModelCount: idx.cadModels.length,
    },
  };
}
