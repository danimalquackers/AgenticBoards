import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map"
import type { BoardSpec } from "../specs/board-spec.schema"
import type { CheckFinding } from "./types"

/**
 * IPC-2221 external trace width (mm) required for `currentA` at `tempRiseC`
 * and `copperOz` oz/ft^2 copper weight.
 */
export function ipc2221MinTraceWidthMm(
  currentA: number,
  tempRiseC: number,
  copperOz: number,
  isInternal = false,
): number {
  if (currentA <= 0) return 0
  const k = isInternal ? 0.024 : 0.048
  const areaMil2 = (currentA / (k * tempRiseC ** 0.44)) ** (1 / 0.725)
  const thicknessMil = copperOz * 1.378
  const widthMil = areaMil2 / thicknessMil
  return widthMil * 0.0254
}

function traceLengthMm(trace: any): number {
  const route = Array.isArray(trace?.route) ? trace.route : []
  let len = 0
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    if (
      typeof a?.x === "number" &&
      typeof a?.y === "number" &&
      typeof b?.x === "number" &&
      typeof b?.y === "number"
    ) {
      len += Math.hypot(b.x - a.x, b.y - a.y)
    }
  }
  return len
}

/**
 * Runs electrical, power-integrity, thermal (IPC-2221), and signal-integrity
 * heuristics against compiled Circuit JSON.
 */
export function runElectricalHeuristics(circuitJson: any[], spec: BoardSpec): CheckFinding[] {
  const findings: CheckFinding[] = []
  const connMap = getFullConnectivityMapFromCircuitJson(circuitJson)

  const sourceNets = circuitJson.filter((el) => el?.type === "source_net")
  const sourceComponents = circuitJson.filter((el) => el?.type === "source_component")
  const sourcePorts = circuitJson.filter((el) => el?.type === "source_port")
  const pcbComponents = circuitJson.filter((el) => el?.type === "pcb_component")
  const pcbTraces = circuitJson.filter((el) => el?.type === "pcb_trace")
  const sourceTraces = circuitJson.filter((el) => el?.type === "source_trace")

  const netByName = new Map<string, any>()
  for (const n of sourceNets) {
    if (n?.name) netByName.set(String(n.name), n)
  }

  // 1. Ground net & dead-short check between power rails and GND
  const gndNet = netByName.get(spec.electrical.groundNetName)
  if (spec.electrical.requireGroundNet && !gndNet) {
    findings.push({
      id: "pi.ground.missing",
      category: "power-integrity",
      severity: "error",
      message: `Required ground net "${spec.electrical.groundNetName}" was not found.`,
    })
  }

  for (const rail of spec.powerRails) {
    const railNet = netByName.get(rail.net)
    if (!railNet) {
      findings.push({
        id: "pi.rail.missing",
        category: "power-integrity",
        severity: "error",
        message: `Power rail net "${rail.net}" (${rail.nominalVoltageV}V) is missing.`,
      })
      continue
    }

    if (gndNet && connMap.areIdsConnected(railNet.source_net_id, gndNet.source_net_id)) {
      findings.push({
        id: "electrical.power_short",
        category: "electrical",
        severity: "error",
        message: `CRITICAL: Power rail "${rail.net}" is shorted directly to "${spec.electrical.groundNetName}"!`,
      })
    }
  }

  // 2. Decoupling capacitor coverage & proximity to ICs
  const capacitors = sourceComponents.filter((c) => c.ftype === "simple_capacitor")
  const pcbBySourceId = new Map(pcbComponents.map((pc) => [pc.source_component_id, pc]))
  const portsByCompId = new Map<string, any[]>()
  for (const p of sourcePorts) {
    const arr = portsByCompId.get(p.source_component_id) ?? []
    arr.push(p)
    portsByCompId.set(p.source_component_id, arr)
  }

  for (const rail of spec.powerRails) {
    if (!rail.requiresDecoupling) continue
    const railNet = netByName.get(rail.net)
    if (!railNet || !gndNet) continue

    const hasCap = capacitors.some((cap) => {
      const capPorts = portsByCompId.get(cap.source_component_id) ?? []
      const onRail = capPorts.some((p) =>
        connMap.areIdsConnected(p.source_port_id, railNet.source_net_id),
      )
      const onGnd = capPorts.some((p) =>
        connMap.areIdsConnected(p.source_port_id, gndNet.source_net_id),
      )
      return onRail && onGnd
    })
    if (!hasCap) {
      findings.push({
        id: "pi.decoupling.missing",
        category: "power-integrity",
        severity: "error",
        message: `Power rail "${rail.net}" requires decoupling, but no capacitor bridges "${rail.net}" to "${spec.electrical.groundNetName}".`,
      })
    }
  }

  for (const chip of sourceComponents.filter((c) => c.ftype === "simple_chip")) {
    const chipPcb = pcbBySourceId.get(chip.source_component_id)
    if (!chipPcb?.center) continue
    const nearest = capacitors.reduce((best, cap) => {
      const cp = pcbBySourceId.get(cap.source_component_id)
      if (!cp?.center) return best
      return Math.min(
        best,
        Math.hypot(cp.center.x - chipPcb.center.x, cp.center.y - chipPcb.center.y),
      )
    }, Number.POSITIVE_INFINITY)

    if (!Number.isFinite(nearest)) {
      findings.push({
        id: "pi.decoupling.ic_missing",
        category: "power-integrity",
        severity: "error",
        message: `IC ${chip.name} has no decoupling capacitor on the board.`,
      })
    } else if (nearest > spec.electrical.maxDecouplingDistanceMm) {
      findings.push({
        id: "pi.decoupling.distance",
        category: "power-integrity",
        severity: "warning",
        message: `IC ${chip.name} nearest decoupling cap is ${nearest.toFixed(1)}mm away (max ${spec.electrical.maxDecouplingDistanceMm}mm).`,
      })
    }
  }

  // 3. Thermal / IPC-2221 ampacity check for power rail traces
  const sourceTraceById = new Map(sourceTraces.map((st) => [st.source_trace_id, st]))
  for (const rail of spec.powerRails) {
    const railNet = netByName.get(rail.net)
    if (!railNet) continue
    const reqWidth = Math.max(
      ipc2221MinTraceWidthMm(
        rail.maxCurrentA,
        spec.electrical.maxTraceTempRiseC,
        spec.dimensions.copperWeightOz,
      ),
      rail.minTraceWidthMm ?? 0,
    )
    if (reqWidth <= 0) continue

    for (const pt of pcbTraces) {
      const st = sourceTraceById.get(pt.source_trace_id)
      const isRail =
        st &&
        (st.connected_source_net_ids?.includes(railNet.source_net_id) ||
          connMap.areIdsConnected(pt.source_trace_id, railNet.source_net_id))
      if (!isRail) continue

      const widths = (pt.route ?? [])
        .map((s: any) => s.width)
        .filter((w: unknown): w is number => typeof w === "number")
      const minW = Math.min(...widths)
      if (Number.isFinite(minW) && minW < reqWidth - 1e-4) {
        findings.push({
          id: "thermal.ampacity.trace_too_narrow",
          category: "thermal",
          severity: "error",
          message: `Net "${rail.net}" (${rail.maxCurrentA}A) trace ${minW.toFixed(3)}mm < required ${reqWidth.toFixed(3)}mm (IPC-2221, ΔT<=${spec.electrical.maxTraceTempRiseC}°C).`,
        })
        break
      }
    }
  }

  // 4. Floating / unconnected pins
  const allowed = new Set(spec.electrical.allowedUnconnectedPins)
  const compById = new Map(sourceComponents.map((c) => [c.source_component_id, c]))
  for (const port of sourcePorts) {
    const ref = `${compById.get(port.source_component_id)?.name ?? port.source_component_id}.${port.name}`
    if (allowed.has(ref)) continue
    const netId = connMap.getNetConnectedToId(port.source_port_id)
    const ids = netId ? connMap.getIdsConnectedToNet(netId) : []
    if (ids.filter((id) => id !== port.source_port_id).length === 0) {
      findings.push({
        id: "electrical.pin.unconnected",
        category: "electrical",
        severity: "warning",
        message: `Pin ${ref} appears unconnected (add to electrical.allowedUnconnectedPins if intentional).`,
      })
    }
  }

  // 5. Signal integrity: stackup advisory & max trace lengths
  if (spec.signalIntegrity.highSpeedNets.length > 0 && spec.dimensions.layers < 4) {
    findings.push({
      id: "si.stackup.ground_plane",
      category: "signal-integrity",
      severity: "warning",
      message: `High-speed nets (${spec.signalIntegrity.highSpeedNets.join(", ")}) on ${spec.dimensions.layers} layers: consider a 4-layer stackup with solid GND plane.`,
    })
  }
  const routedLengthForNet = (netName: string): number | null => {
    const net = netByName.get(netName)
    if (!net) return null
    let totalLen = 0
    for (const pt of pcbTraces) {
      if (connMap.areIdsConnected(pt.source_trace_id ?? pt.pcb_trace_id, net.source_net_id)) {
        totalLen += traceLengthMm(pt)
      }
    }
    return totalLen
  }

  for (const [netName, maxLen] of Object.entries(spec.signalIntegrity.maxTraceLengthMm)) {
    const totalLen = routedLengthForNet(netName)
    if (totalLen !== null && totalLen > maxLen) {
      findings.push({
        id: "si.trace_length.exceeded",
        category: "signal-integrity",
        severity: "error",
        message: `Net "${netName}" routed length ${totalLen.toFixed(1)}mm exceeds maxTraceLengthMm (${maxLen}mm).`,
      })
    }
  }

  for (const [netA, netB] of spec.signalIntegrity.differentialPairs) {
    const lenA = routedLengthForNet(netA)
    const lenB = routedLengthForNet(netB)
    if (lenA === null || lenB === null) {
      findings.push({
        id: "si.diff_pair.missing",
        category: "signal-integrity",
        severity: "error",
        message: `Differential pair (${netA}, ${netB}) is missing one or both nets.`,
      })
      continue
    }
    const skew = Math.abs(lenA - lenB)
    if (skew > spec.signalIntegrity.maxDiffPairSkewMm) {
      findings.push({
        id: "si.diff_pair.skew",
        category: "signal-integrity",
        severity: "error",
        message: `Differential pair (${netA}=${lenA.toFixed(2)}mm, ${netB}=${lenB.toFixed(2)}mm) skew ${skew.toFixed(2)}mm exceeds maxDiffPairSkewMm (${spec.signalIntegrity.maxDiffPairSkewMm}mm).`,
      })
    }
  }

  // 6. Silkscreen board labeling check for non-empty boards
  const silkTexts = circuitJson.filter((el) => el?.type === "pcb_silkscreen_text")
  if (sourceComponents.length > 0 && silkTexts.length === 0) {
    findings.push({
      id: "fab.silkscreen.missing_board_label",
      category: "fab",
      severity: "warning",
      message:
        "No silkscreen labels found; add board name/revision and connector pin labels before fab.",
    })
  }

  return findings
}
