import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map";
import type { CheckCategory, CheckFinding } from "./types";

export interface RouteSegment {
  a: any;
  b: any;
  lengthMm: number;
  widthMm: number | undefined;
  layer: string | undefined;
}

export interface CircuitIndex {
  raw: any[];
  connMap: ReturnType<typeof getFullConnectivityMapFromCircuitJson>;
  pcbBoard: any | undefined;
  sourceComponents: any[];
  pcbComponents: any[];
  sourceTraces: any[];
  pcbTraces: any[];
  pcbVias: any[];
  pcbHoles: any[];
  cadModels: any[];
  sourceNets: any[];
  sourcePorts: any[];
  pcbPorts: any[];
  silkTexts: any[];
  netByName: Map<string, any>;
  compById: Map<string, any>;
  pcbBySourceId: Map<string, any>;
  pcbPortBySourcePortId: Map<string, any>;
  sourceTraceById: Map<string, any>;
  portsByCompId: Map<string, any[]>;
}

export function finding(
  severity: "error" | "warning",
  category: CheckCategory,
  id: string,
  message: string,
  details?: Record<string, unknown>,
): CheckFinding {
  return details
    ? { id, category, severity, message, details }
    : { id, category, severity, message };
}

export const error = (
  category: CheckCategory,
  id: string,
  message: string,
  details?: Record<string, unknown>,
): CheckFinding => finding("error", category, id, message, details);

export const warn = (
  category: CheckCategory,
  id: string,
  message: string,
  details?: Record<string, unknown>,
): CheckFinding => finding("warning", category, id, message, details);

export function isDirectRun(importMetaUrl: string): boolean {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function isTestPoint(comp: any): boolean {
  return comp?.ftype === "simple_test_point" || /^TP(?:[_0-9]|$)/i.test(String(comp?.name ?? ""));
}

export function distanceMm(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Yields each numeric wire segment along a `pcb_trace.route`. */
export function* routeSegments(trace: any): Generator<RouteSegment> {
  const route = Array.isArray(trace?.route) ? trace.route : [];

  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];

    const hasCoords =
      typeof a?.x === "number" &&
      typeof a?.y === "number" &&
      typeof b?.x === "number" &&
      typeof b?.y === "number";

    if (!hasCoords) continue;

    yield {
      a,
      b,
      lengthMm: distanceMm(a, b),
      widthMm: typeof b.width === "number" ? b.width : a.width,
      layer: typeof b.layer === "string" ? b.layer : a.layer,
    };
  }
}

export function traceLengthMm(trace: any): number {
  let total = 0;

  for (const seg of routeSegments(trace)) {
    total += seg.lengthMm;
  }

  return total;
}

export function netRoutedLengthMm(idx: CircuitIndex, netName: string): number | null {
  const net = idx.netByName.get(netName);
  if (!net) return null;

  let total = 0;

  for (const pt of idx.pcbTraces) {
    const traceConnId = pt.source_trace_id || pt.pcb_trace_id;
    if (idx.connMap.areIdsConnected(traceConnId, net.source_net_id)) {
      total += traceLengthMm(pt);
    }
  }

  return total;
}

/** Indexes a Circuit JSON array in a single pass with shared lookup maps and connectivity graph. */
export function indexCircuit(circuitJson: any[]): CircuitIndex {
  const buckets = {
    sourceComponents: [] as any[],
    pcbComponents: [] as any[],
    sourceTraces: [] as any[],
    pcbTraces: [] as any[],
    pcbVias: [] as any[],
    pcbHoles: [] as any[],
    cadModels: [] as any[],
    sourceNets: [] as any[],
    sourcePorts: [] as any[],
    pcbPorts: [] as any[],
    silkTexts: [] as any[],
  };

  const bucketByType: Record<string, any[]> = {
    source_component: buckets.sourceComponents,
    pcb_component: buckets.pcbComponents,
    source_trace: buckets.sourceTraces,
    pcb_trace: buckets.pcbTraces,
    pcb_via: buckets.pcbVias,
    pcb_hole: buckets.pcbHoles,
    pcb_plated_hole: buckets.pcbHoles,
    cad_component: buckets.cadModels,
    source_net: buckets.sourceNets,
    source_port: buckets.sourcePorts,
    pcb_port: buckets.pcbPorts,
    pcb_silkscreen_text: buckets.silkTexts,
  };

  let pcbBoard: any;

  for (const el of circuitJson) {
    if (el?.type === "pcb_board") {
      pcbBoard ??= el;
      continue;
    }

    bucketByType[el?.type]?.push(el);
  }

  const netByName = new Map<string, any>();
  for (const net of buckets.sourceNets) {
    if (net?.name) netByName.set(String(net.name), net);
  }

  const portsByCompId = new Map<string, any[]>();
  for (const port of buckets.sourcePorts) {
    const list = portsByCompId.get(port.source_component_id) ?? [];
    list.push(port);
    portsByCompId.set(port.source_component_id, list);
  }

  return {
    raw: circuitJson,
    connMap: getFullConnectivityMapFromCircuitJson(circuitJson),
    pcbBoard,
    ...buckets,
    netByName,
    compById: new Map(buckets.sourceComponents.map((c) => [c.source_component_id, c])),
    pcbBySourceId: new Map(buckets.pcbComponents.map((pc) => [pc.source_component_id, pc])),
    pcbPortBySourcePortId: new Map(buckets.pcbPorts.map((pp) => [pp.source_port_id, pp])),
    sourceTraceById: new Map(buckets.sourceTraces.map((st) => [st.source_trace_id, st])),
    portsByCompId,
  };
}
