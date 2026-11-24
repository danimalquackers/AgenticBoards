import type { BoardSpec } from "../specs/board-spec.schema";
import {
  type CircuitIndex,
  distanceMm,
  error,
  isTestPoint,
  netRoutedLengthMm,
  routeSegments,
  warn,
} from "./circuit-index";
import type { CheckFinding } from "./types";

/**
 * IPC-2221 trace width (mm) required for `currentA` at `tempRiseC`
 * and `copperOz` oz/ft^2 copper weight.
 */
export function ipc2221MinTraceWidthMm(
  currentA: number,
  tempRiseC: number,
  copperOz: number,
  isInternal = false,
): number {
  if (currentA <= 0) return 0;

  const k = isInternal ? 0.024 : 0.048;
  const areaMil2 = (currentA / (k * tempRiseC ** 0.44)) ** (1 / 0.725);
  const thicknessMil = copperOz * 1.378;
  return (areaMil2 / thicknessMil) * 0.0254;
}

function requiredRailWidthMm(
  rail: BoardSpec["powerRails"][number],
  spec: BoardSpec,
  isInternal: boolean,
): number {
  const ipcMin = ipc2221MinTraceWidthMm(
    rail.maxCurrentA,
    spec.electrical.maxTraceTempRiseC,
    spec.dimensions.copperWeightOz,
    isInternal,
  );

  return Math.max(ipcMin, rail.minTraceWidthMm ?? 0);
}

function checkPowerRailsAndShorts(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const gndNet = idx.netByName.get(spec.electrical.groundNetName);

  if (spec.electrical.requireGroundNet && !gndNet) {
    findings.push(
      error(
        "power-integrity",
        "pi.ground.missing",
        `Required ground net "${spec.electrical.groundNetName}" was not found.`,
      ),
    );
  }

  for (const rail of spec.powerRails) {
    const railNet = idx.netByName.get(rail.net);
    if (!railNet) {
      findings.push(
        error(
          "power-integrity",
          "pi.rail.missing",
          `Power rail net "${rail.net}" (${rail.nominalVoltageV}V) is missing.`,
        ),
      );
      continue;
    }

    if (gndNet && idx.connMap.areIdsConnected(railNet.source_net_id, gndNet.source_net_id)) {
      findings.push(
        error(
          "electrical",
          "electrical.power_short",
          `CRITICAL: Power rail "${rail.net}" is shorted directly to "${spec.electrical.groundNetName}"!`,
        ),
      );
    }
  }

  return findings;
}

function checkRailDecoupling(
  idx: CircuitIndex,
  spec: BoardSpec,
  capacitors: any[],
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const gndNet = idx.netByName.get(spec.electrical.groundNetName);
  if (!gndNet) return findings;

  for (const rail of spec.powerRails) {
    if (!rail.requiresDecoupling) continue;

    const railNet = idx.netByName.get(rail.net);
    if (!railNet) continue;

    const hasCap = capacitors.some((cap) => {
      const ports = idx.portsByCompId.get(cap.source_component_id) ?? [];
      const onRail = ports.some((p) =>
        idx.connMap.areIdsConnected(p.source_port_id, railNet.source_net_id),
      );
      const onGnd = ports.some((p) =>
        idx.connMap.areIdsConnected(p.source_port_id, gndNet.source_net_id),
      );
      return onRail && onGnd;
    });

    if (!hasCap) {
      findings.push(
        error(
          "power-integrity",
          "pi.decoupling.missing",
          `Power rail "${rail.net}" requires decoupling, but no capacitor bridges "${rail.net}" to "${spec.electrical.groundNetName}".`,
        ),
      );
    }
  }

  return findings;
}

function checkIcDecouplingProximity(
  idx: CircuitIndex,
  spec: BoardSpec,
  capacitors: any[],
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const chips = idx.sourceComponents.filter((c) => c.ftype === "simple_chip");

  for (const chip of chips) {
    const chipPcb = idx.pcbBySourceId.get(chip.source_component_id);
    if (!chipPcb?.center) continue;

    let nearest = Number.POSITIVE_INFINITY;
    for (const cap of capacitors) {
      const capPcb = idx.pcbBySourceId.get(cap.source_component_id);
      if (capPcb?.center) {
        nearest = Math.min(nearest, distanceMm(chipPcb.center, capPcb.center));
      }
    }

    if (!Number.isFinite(nearest)) {
      findings.push(
        error(
          "power-integrity",
          "pi.decoupling.ic_missing",
          `IC ${chip.name} has no decoupling capacitor on the board.`,
        ),
      );
    } else if (nearest > spec.electrical.maxDecouplingDistanceMm) {
      findings.push(
        warn(
          "power-integrity",
          "pi.decoupling.distance",
          `IC ${chip.name} nearest decoupling cap is ${nearest.toFixed(1)}mm away (max ${spec.electrical.maxDecouplingDistanceMm}mm).`,
        ),
      );
    }
  }

  return findings;
}

function checkTraceAmpacity(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];

  for (const rail of spec.powerRails) {
    const railNet = idx.netByName.get(rail.net);
    if (!railNet) continue;

    // A dedicated copper pour on this rail carries bulk current; skip narrow-fanout ampacity flags.
    const hasCopperPour = idx.pcbCopperPours.some(
      (pour) =>
        pour.source_net_id === railNet.source_net_id ||
        idx.connMap.areIdsConnected(
          pour.source_net_id || pour.pcb_copper_pour_id,
          railNet.source_net_id,
        ),
    );
    if (hasCopperPour) continue;

    const reqExternal = requiredRailWidthMm(rail, spec, false);
    const reqInternal = requiredRailWidthMm(rail, spec, true);
    if (reqExternal <= 0 && reqInternal <= 0) continue;

    for (const pt of idx.pcbTraces) {
      const st = idx.sourceTraceById.get(pt.source_trace_id);
      const traceConnId = pt.source_trace_id || pt.pcb_trace_id;
      const isRail =
        Boolean(st?.connected_source_net_ids?.includes(railNet.source_net_id)) ||
        idx.connMap.areIdsConnected(traceConnId, railNet.source_net_id);

      if (!isRail) continue;

      let totalLen = 0;
      let narrowLen = 0;
      let worstWidth = Number.POSITIVE_INFINITY;
      let worstReq = reqExternal;

      for (const seg of routeSegments(pt)) {
        totalLen += seg.lengthMm;
        const reqWidth = seg.layer?.startsWith("inner") ? reqInternal : reqExternal;

        if (seg.widthMm !== undefined && seg.widthMm < reqWidth - 1e-4) {
          narrowLen += seg.lengthMm;
          if (seg.widthMm < worstWidth) {
            worstWidth = seg.widthMm;
            worstReq = reqWidth;
          }
        }
      }

      // Allow short (<= 1.5mm and <= 25% of trace) pad-fanout necks while flagging undersized runs.
      const significantNarrowRun = narrowLen > 1.5 || (totalLen > 0 && narrowLen / totalLen > 0.25);
      if (significantNarrowRun && Number.isFinite(worstWidth)) {
        findings.push(
          error(
            "thermal",
            "thermal.ampacity.trace_too_narrow",
            `Net "${rail.net}" (${rail.maxCurrentA}A) trace ${worstWidth.toFixed(3)}mm < required ${worstReq.toFixed(3)}mm across ${narrowLen.toFixed(1)}mm (IPC-2221, ΔT<=${spec.electrical.maxTraceTempRiseC}°C).`,
          ),
        );
        break;
      }
    }
  }

  return findings;
}

function checkFloatingPins(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const allowed = new Set(spec.electrical.allowedUnconnectedPins);

  for (const port of idx.sourcePorts) {
    const compName = idx.compById.get(port.source_component_id)?.name ?? port.source_component_id;
    const ref = `${compName}.${port.name}`;
    if (allowed.has(ref)) continue;

    const netId = idx.connMap.getNetConnectedToId(port.source_port_id);
    const connected = netId ? idx.connMap.getIdsConnectedToNet(netId) : [];

    if (connected.filter((id) => id !== port.source_port_id).length === 0) {
      findings.push(
        warn(
          "electrical",
          "electrical.pin.unconnected",
          `Pin ${ref} appears unconnected (add to electrical.allowedUnconnectedPins if intentional).`,
        ),
      );
    }
  }

  return findings;
}

function checkSignalIntegrity(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const { highSpeedNets, maxTraceLengthMm, differentialPairs, maxDiffPairSkewMm } =
    spec.signalIntegrity;

  if (highSpeedNets.length > 0 && spec.dimensions.layers < 4) {
    findings.push(
      warn(
        "signal-integrity",
        "si.stackup.ground_plane",
        `High-speed nets (${highSpeedNets.join(", ")}) on ${spec.dimensions.layers} layers: consider a 4-layer stackup with solid GND plane.`,
      ),
    );
  }

  for (const [netName, maxLen] of Object.entries(maxTraceLengthMm)) {
    const totalLen = netRoutedLengthMm(idx, netName);
    if (totalLen !== null && totalLen > maxLen) {
      findings.push(
        error(
          "signal-integrity",
          "si.trace_length.exceeded",
          `Net "${netName}" routed length ${totalLen.toFixed(1)}mm exceeds maxTraceLengthMm (${maxLen}mm).`,
        ),
      );
    }
  }

  for (const [netA, netB] of differentialPairs) {
    const lenA = netRoutedLengthMm(idx, netA);
    const lenB = netRoutedLengthMm(idx, netB);

    if (lenA === null || lenB === null) {
      findings.push(
        error(
          "signal-integrity",
          "si.diff_pair.missing",
          `Differential pair (${netA}, ${netB}) is missing one or both nets.`,
        ),
      );
      continue;
    }

    const skew = Math.abs(lenA - lenB);
    if (skew > maxDiffPairSkewMm) {
      findings.push(
        error(
          "signal-integrity",
          "si.diff_pair.skew",
          `Differential pair (${netA}=${lenA.toFixed(2)}mm, ${netB}=${lenB.toFixed(2)}mm) skew ${skew.toFixed(2)}mm exceeds maxDiffPairSkewMm (${maxDiffPairSkewMm}mm).`,
        ),
      );
    }
  }

  return findings;
}

function checkSilkscreen(idx: CircuitIndex): CheckFinding[] {
  if (idx.sourceComponents.length > 0 && idx.silkTexts.length === 0) {
    return [
      warn(
        "fab",
        "fab.silkscreen.missing_board_label",
        "No silkscreen labels found; add board name/revision and connector pin labels before fab.",
      ),
    ];
  }

  return [];
}

function checkTestPointCoverage(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const testPoints = idx.sourceComponents.filter(isTestPoint);

  const hasTestPointOnNet = (netId: string): boolean =>
    testPoints.some((tp) => {
      const ports = idx.portsByCompId.get(tp.source_component_id) ?? [];
      return ports.some((p) => idx.connMap.areIdsConnected(p.source_port_id, netId));
    });

  if (spec.powerRails.length > 0) {
    const gndNet = idx.netByName.get(spec.electrical.groundNetName);
    if (gndNet && !hasTestPointOnNet(gndNet.source_net_id)) {
      findings.push(
        warn(
          "electrical",
          "dft.testpoint.missing_ground",
          `Consider adding an accessible GND test point (${spec.electrical.groundNetName}) for bench bring-up.`,
        ),
      );
    }

    for (const rail of spec.powerRails) {
      const railNet = idx.netByName.get(rail.net);
      if (railNet && !hasTestPointOnNet(railNet.source_net_id)) {
        findings.push(
          warn(
            "electrical",
            "dft.testpoint.missing_rail",
            `Power rail "${rail.net}" (${rail.nominalVoltageV}V) has no test point; consider adding a compact pad if space permits.`,
          ),
        );
      }
    }
  }

  for (const hsName of spec.signalIntegrity.highSpeedNets) {
    const hsNet = idx.netByName.get(hsName);
    if (hsNet && hasTestPointOnNet(hsNet.source_net_id)) {
      findings.push(
        warn(
          "signal-integrity",
          "dft.testpoint.on_high_speed_net",
          `Test point attached to high-speed/RF net "${hsName}"; avoid stub test points on controlled-impedance lines.`,
        ),
      );
    }
  }

  return findings;
}

function checkSchematicLayout(idx: CircuitIndex): CheckFinding[] {
  if (idx.sourceComponents.length === 0) return [];

  const findings: CheckFinding[] = [];

  if (idx.schematicSheets.length === 0) {
    findings.push(
      warn(
        "drc",
        "schematic.sheet.missing",
        'Add a <schematicsheet name="main" sheetSize="A4" /> frame so the schematic renders as a structured engineering sheet.',
      ),
    );
  }

  if (idx.sourceComponents.length >= 6 && idx.schematicBoxes.length === 0) {
    findings.push(
      warn(
        "drc",
        "schematic.boxes.missing",
        'Group functional blocks with titled <schematicbox title="..." strokeStyle="dashed" overlay={[...]} /> boxes for human review.',
      ),
    );
  }

  const placed = idx.schematicComponents.filter(
    (c) => typeof c?.center?.x === "number" && typeof c?.center?.y === "number",
  );
  if (placed.length >= 6) {
    const xs = placed.map((c) => c.center.x as number);
    const ys = placed.map((c) => c.center.y as number);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const ratio = spanX > 0 && spanY > 0 ? Math.max(spanX / spanY, spanY / spanX) : 0;

    if (ratio > 4.0) {
      findings.push(
        warn(
          "drc",
          "schematic.layout.aspect_ratio",
          `Schematic bounding box is ${spanX.toFixed(1)}x${spanY.toFixed(1)} (${ratio.toFixed(1)}:1 aspect ratio); arrange functional blocks in a compact rectangular grid.`,
        ),
      );
    }
  }

  return findings;
}

/** Runs electrical, power-integrity, thermal (IPC-2221), and signal-integrity heuristics. */
export function runElectricalHeuristics(idx: CircuitIndex, spec: BoardSpec): CheckFinding[] {
  const capacitors = idx.sourceComponents.filter((c) => c.ftype === "simple_capacitor");

  return [
    ...checkPowerRailsAndShorts(idx, spec),
    ...checkRailDecoupling(idx, spec, capacitors),
    ...checkIcDecouplingProximity(idx, spec, capacitors),
    ...checkTraceAmpacity(idx, spec),
    ...checkFloatingPins(idx, spec),
    ...checkSignalIntegrity(idx, spec),
    ...checkSilkscreen(idx),
    ...checkTestPointCoverage(idx, spec),
    ...checkSchematicLayout(idx),
  ];
}
