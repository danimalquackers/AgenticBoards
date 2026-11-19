import type { BoardSpec } from "../specs/board-spec.schema"
import type { BomSummary, CheckFinding } from "./types"

export interface ConstraintCheckOutput {
  findings: CheckFinding[]
  bom: BomSummary
  boardMetrics: {
    widthMm: number | null
    heightMm: number | null
    layers: number | null
    componentCount: number
    traceCount: number
    viaCount: number
    holeCount: number
    cadModelCount: number
  }
}

/**
 * Validates mechanical, fab, component, net, 3D model, and BOM budget rules
 * declared in `specs/board.spec.json`.
 */
export function runConstraintChecks(circuitJson: any[], spec: BoardSpec): ConstraintCheckOutput {
  const findings: CheckFinding[] = []

  const pcbBoard = circuitJson.find((el) => el?.type === "pcb_board")
  const sourceComponents = circuitJson.filter((el) => el?.type === "source_component")
  const pcbComponents = circuitJson.filter((el) => el?.type === "pcb_component")
  const pcbTraces = circuitJson.filter((el) => el?.type === "pcb_trace")
  const pcbVias = circuitJson.filter((el) => el?.type === "pcb_via")
  const pcbHoles = circuitJson.filter(
    (el) => el?.type === "pcb_hole" || el?.type === "pcb_plated_hole",
  )
  const cadModels = circuitJson.filter((el) => el?.type === "cad_component")
  const sourceNets = circuitJson.filter((el) => el?.type === "source_net")

  const widthMm: number | null = typeof pcbBoard?.width === "number" ? pcbBoard.width : null
  const heightMm: number | null = typeof pcbBoard?.height === "number" ? pcbBoard.height : null
  const layers: number | null =
    typeof pcbBoard?.num_layers === "number" ? pcbBoard.num_layers : null

  // 1. Dimensions & layer stackup
  if (!pcbBoard || widthMm === null || heightMm === null) {
    findings.push({
      id: "mechanical.board.missing",
      category: "mechanical",
      severity: "error",
      message: "No pcb_board with numeric width/height found in Circuit JSON.",
    })
  } else {
    if (widthMm > spec.dimensions.maxWidthMm + spec.dimensions.toleranceMm) {
      findings.push({
        id: "mechanical.width.max",
        category: "mechanical",
        severity: "error",
        message: `Board width ${widthMm.toFixed(2)}mm exceeds maxWidthMm (${spec.dimensions.maxWidthMm}mm).`,
      })
    }
    if (heightMm > spec.dimensions.maxHeightMm + spec.dimensions.toleranceMm) {
      findings.push({
        id: "mechanical.height.max",
        category: "mechanical",
        severity: "error",
        message: `Board height ${heightMm.toFixed(2)}mm exceeds maxHeightMm (${spec.dimensions.maxHeightMm}mm).`,
      })
    }
    if (
      spec.dimensions.exactWidthMm !== undefined &&
      Math.abs(widthMm - spec.dimensions.exactWidthMm) > spec.dimensions.toleranceMm
    ) {
      findings.push({
        id: "mechanical.width.exact",
        category: "mechanical",
        severity: "error",
        message: `Board width ${widthMm.toFixed(2)}mm does not match exactWidthMm (${spec.dimensions.exactWidthMm}±${spec.dimensions.toleranceMm}mm).`,
      })
    }
    if (
      spec.dimensions.exactHeightMm !== undefined &&
      Math.abs(heightMm - spec.dimensions.exactHeightMm) > spec.dimensions.toleranceMm
    ) {
      findings.push({
        id: "mechanical.height.exact",
        category: "mechanical",
        severity: "error",
        message: `Board height ${heightMm.toFixed(2)}mm does not match exactHeightMm (${spec.dimensions.exactHeightMm}±${spec.dimensions.toleranceMm}mm).`,
      })
    }
    if (layers !== null && layers !== spec.dimensions.layers) {
      findings.push({
        id: "mechanical.layers.mismatch",
        category: "mechanical",
        severity: "error",
        message: `Board has ${layers} layers, but spec requires ${spec.dimensions.layers} layers.`,
      })
    }
  }

  // 2. Mounting holes
  for (const reqHole of spec.mountingHoles) {
    const matched = pcbHoles.some((h) => {
      const dx = Math.abs((h.x ?? 0) - reqHole.xMm)
      const dy = Math.abs((h.y ?? 0) - reqHole.yMm)
      const dia = h.hole_diameter ?? h.diameter ?? 0
      const dd = Math.abs(dia - reqHole.diameterMm)
      return dx <= reqHole.toleranceMm && dy <= reqHole.toleranceMm && dd <= reqHole.toleranceMm
    })
    if (!matched) {
      findings.push({
        id: "mechanical.mounting_hole.missing",
        category: "mechanical",
        severity: "error",
        message: `Required mounting hole ${reqHole.name ?? ""} at (${reqHole.xMm}, ${reqHole.yMm})mm Ø${reqHole.diameterMm}mm not found.`,
      })
    }
  }

  // 3. Keepout zones
  for (const zone of spec.keepoutZones) {
    const zMinX = zone.xMm - zone.widthMm / 2
    const zMaxX = zone.xMm + zone.widthMm / 2
    const zMinY = zone.yMm - zone.heightMm / 2
    const zMaxY = zone.yMm + zone.heightMm / 2

    for (const comp of pcbComponents) {
      const cx = comp.center?.x ?? 0
      const cy = comp.center?.y ?? 0
      const cw = comp.width ?? 0
      const ch = comp.height ?? 0
      const overlaps =
        cx + cw / 2 > zMinX && cx - cw / 2 < zMaxX && cy + ch / 2 > zMinY && cy - ch / 2 < zMaxY
      if (overlaps) {
        findings.push({
          id: "mechanical.keepout.violation",
          category: "mechanical",
          severity: "error",
          message: `Component ${comp.source_component_id ?? comp.pcb_component_id} overlaps keepout zone "${zone.name}".`,
        })
      }
    }
  }

  // 4. Fab rules: trace widths, vias, copper-to-edge clearance, and routing completeness
  const sourceTraces = circuitJson.filter((el) => el?.type === "source_trace")
  const routedSourceTraceIds = new Set(
    pcbTraces.filter((t) => (t.route?.length ?? 0) >= 2).map((t) => t.source_trace_id),
  )
  for (const st of sourceTraces) {
    if (!routedSourceTraceIds.has(st.source_trace_id)) {
      findings.push({
        id: "drc.unrouted_trace",
        category: "drc",
        severity: "error",
        message: `Source trace ${st.source_trace_id} has no routed PCB copper trace (unrouted airwire).`,
      })
    }
  }

  const boardCenterX = pcbBoard?.center?.x ?? 0
  const boardCenterY = pcbBoard?.center?.y ?? 0
  const edgeLimitX =
    widthMm !== null ? widthMm / 2 - spec.fabRules.minEdgeClearanceMm : Number.POSITIVE_INFINITY
  const edgeLimitY =
    heightMm !== null ? heightMm / 2 - spec.fabRules.minEdgeClearanceMm : Number.POSITIVE_INFINITY

  for (const trace of pcbTraces) {
    for (const seg of trace.route ?? []) {
      if (typeof seg.width === "number" && seg.width < spec.fabRules.minTraceWidthMm - 1e-4) {
        findings.push({
          id: "fab.trace_width.min",
          category: "fab",
          severity: "error",
          message: `Trace ${trace.pcb_trace_id} width ${seg.width}mm < fab min ${spec.fabRules.minTraceWidthMm}mm.`,
        })
        break
      }
      const halfW = typeof seg.width === "number" ? seg.width / 2 : 0
      if (
        typeof seg.x === "number" &&
        typeof seg.y === "number" &&
        (Math.abs(seg.x - boardCenterX) + halfW > edgeLimitX + 1e-3 ||
          Math.abs(seg.y - boardCenterY) + halfW > edgeLimitY + 1e-3)
      ) {
        findings.push({
          id: "fab.edge_clearance.trace",
          category: "fab",
          severity: "error",
          message: `Trace ${trace.pcb_trace_id} violates minEdgeClearanceMm (${spec.fabRules.minEdgeClearanceMm}mm) from board outline.`,
        })
        break
      }
    }
  }
  for (const via of pcbVias) {
    if (typeof via.hole_diameter === "number" && via.hole_diameter < spec.fabRules.minViaDrillMm) {
      findings.push({
        id: "fab.via_drill.min",
        category: "fab",
        severity: "error",
        message: `Via ${via.pcb_via_id} drill ${via.hole_diameter}mm < fab min ${spec.fabRules.minViaDrillMm}mm.`,
      })
    }
    if (
      typeof via.outer_diameter === "number" &&
      via.outer_diameter < spec.fabRules.minViaDiameterMm
    ) {
      findings.push({
        id: "fab.via_diameter.min",
        category: "fab",
        severity: "error",
        message: `Via ${via.pcb_via_id} outer Ø ${via.outer_diameter}mm < fab min ${spec.fabRules.minViaDiameterMm}mm.`,
      })
    }
    const viaR = (via.outer_diameter ?? 0) / 2
    if (
      typeof via.x === "number" &&
      typeof via.y === "number" &&
      (Math.abs(via.x - boardCenterX) + viaR > edgeLimitX + 1e-3 ||
        Math.abs(via.y - boardCenterY) + viaR > edgeLimitY + 1e-3)
    ) {
      findings.push({
        id: "fab.edge_clearance.via",
        category: "fab",
        severity: "error",
        message: `Via ${via.pcb_via_id} violates minEdgeClearanceMm (${spec.fabRules.minEdgeClearanceMm}mm) from board outline.`,
      })
    }
  }

  // 5. Required components & nets
  for (const req of spec.requiredComponents) {
    const regex = req.namePattern ? new RegExp(req.namePattern) : null
    const matches = sourceComponents.filter((c) => {
      const nameOk = regex ? regex.test(String(c.name ?? "")) : true
      const ftypeOk = req.ftype ? c.ftype === req.ftype : true
      return nameOk && ftypeOk
    })
    if (matches.length < req.minCount) {
      findings.push({
        id: "mechanical.required_component.missing",
        category: "electrical",
        severity: "error",
        message: `Required "${req.description}": expected >=${req.minCount}, found ${matches.length}.`,
      })
    }
  }

  const netNames = new Set(sourceNets.map((n) => String(n.name ?? "")))
  for (const reqNet of spec.requiredNets) {
    if (!netNames.has(reqNet)) {
      findings.push({
        id: "electrical.required_net.missing",
        category: "electrical",
        severity: "error",
        message: `Required net "${reqNet}" is missing from the compiled circuit.`,
      })
    }
  }

  // 6. Footprint & 3D model coverage
  if (spec.electrical.requireFootprints) {
    const pcbBySource = new Set(pcbComponents.map((c) => c.source_component_id))
    for (const sc of sourceComponents) {
      if (!pcbBySource.has(sc.source_component_id)) {
        findings.push({
          id: "fab.footprint.missing",
          category: "fab",
          severity: "error",
          message: `Component ${sc.name} has no PCB footprint placed on the board.`,
        })
      }
    }
  }
  if (spec.electrical.require3dModels) {
    const cadByPcb = new Set(cadModels.map((c) => c.pcb_component_id))
    for (const pc of pcbComponents) {
      if (!cadByPcb.has(pc.pcb_component_id)) {
        findings.push({
          id: "mechanical.3d_model.missing",
          category: "mechanical",
          severity: "warning",
          message: `Component ${pc.source_component_id} has no 3D CAD model attached.`,
        })
      }
    }
  }

  // 7. BOM cost, part-number completeness & budget validation
  let bomCostUsd = 0
  let pricedComponents = 0
  const unpricedDesignators: string[] = []
  const missingPartNums: string[] = []
  for (const sc of sourceComponents) {
    const name = String(sc.name ?? "")
    const entry = spec.budget.bomCosts[name]
    if (entry) {
      bomCostUsd += entry.unitCostUsd
      pricedComponents += 1
    } else {
      unpricedDesignators.push(name)
    }
    const hasPartNum = Boolean(
      entry?.lcsc || entry?.mpn || sc.supplier_part_numbers?.jlcpcb?.length,
    )
    if (!hasPartNum) missingPartNums.push(name)
  }
  const totalUnitCostUsd = bomCostUsd + spec.budget.estimatedFabUnitUsd

  if (unpricedDesignators.length > 0) {
    findings.push({
      id: "budget.bom.unpriced",
      category: "budget",
      severity: "error",
      message: `${unpricedDesignators.length} component(s) missing from specs/board.spec.json budget.bomCosts: ${unpricedDesignators.join(", ")}.`,
    })
  }
  if (missingPartNums.length > 0) {
    findings.push({
      id: "fab.bom.missing_part_number",
      category: "fab",
      severity: "warning",
      message: `${missingPartNums.length} component(s) lack an LCSC/MPN part number for PCBA: ${missingPartNums.join(", ")}.`,
    })
  }
  if (bomCostUsd > spec.budget.maxBomUsd) {
    findings.push({
      id: "budget.bom.exceeded",
      category: "budget",
      severity: "error",
      message: `BOM cost $${bomCostUsd.toFixed(2)} exceeds maxBomUsd ($${spec.budget.maxBomUsd.toFixed(2)}).`,
    })
  }
  if (spec.budget.maxTotalUnitUsd !== undefined && totalUnitCostUsd > spec.budget.maxTotalUnitUsd) {
    findings.push({
      id: "budget.total.exceeded",
      category: "budget",
      severity: "error",
      message: `Estimated unit cost $${totalUnitCostUsd.toFixed(2)} exceeds maxTotalUnitUsd ($${spec.budget.maxTotalUnitUsd.toFixed(2)}).`,
    })
  }

  return {
    findings,
    bom: {
      totalComponents: sourceComponents.length,
      pricedComponents,
      unpricedDesignators,
      bomCostUsd: Number(bomCostUsd.toFixed(4)),
      estimatedFabUnitUsd: spec.budget.estimatedFabUnitUsd,
      totalUnitCostUsd: Number(totalUnitCostUsd.toFixed(4)),
      maxBomUsd: spec.budget.maxBomUsd,
      maxTotalUnitUsd: spec.budget.maxTotalUnitUsd,
    },
    boardMetrics: {
      widthMm,
      heightMm,
      layers,
      componentCount: sourceComponents.length,
      traceCount: pcbTraces.length,
      viaCount: pcbVias.length,
      holeCount: pcbHoles.length,
      cadModelCount: cadModels.length,
    },
  }
}
