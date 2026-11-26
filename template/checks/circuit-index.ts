import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map";
import type { BoardSpec } from "../specs/board-spec.schema";
import type { CheckCategory, CheckFinding } from "./types";

export const WIDTH_EPSILON_MM = 1e-4;

export interface Point2D {
  x: number;
  y: number;
}

export interface Box2D {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface RouteSegment {
  a: any;
  b: any;
  lengthMm: number;
  widthMm: number | undefined;
  layer: string | undefined;
}

export interface KicadDrcSummary {
  present: boolean;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  unconnectedCount: number;
  errors: Array<{ type?: string; description?: string }>;
  unconnected: Array<{ description?: string }>;
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
  pcbCopperPours: any[];
  cadModels: any[];
  sourceNets: any[];
  sourcePorts: any[];
  pcbPorts: any[];
  silkTexts: any[];
  schematicComponents: any[];
  schematicBoxes: any[];
  schematicSheets: any[];
  nativeErrors: any[];
  nativeWarnings: any[];
  hasAutoroutingError: boolean;
  netByName: Map<string, any>;
  compById: Map<string, any>;
  pcbBySourceId: Map<string, any>;
  pcbPortBySourcePortId: Map<string, any>;
  sourceTraceById: Map<string, any>;
  portsByCompId: Map<string, any[]>;
  sourcePortIdSet: Set<string>;
  sourceNetIdSet: Set<string>;
  tracesByNetId: Map<string, any[]>;
  netNameByConnNetId: Map<string, string>;
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

export function readJson<T = unknown>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read JSON "${filePath}": ${msg}`);
  }
}

export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function parseKicadDrcReport(reportPath: string): KicadDrcSummary | null {
  if (!existsSync(reportPath)) return null;

  const raw = readJson<{
    violations?: Array<{ severity?: string; type?: string; description?: string }>;
    unconnected_items?: Array<{ description?: string }>;
  }>(reportPath);

  const violations = raw.violations ?? [];
  const errors = violations.filter((v) => v.severity === "error");
  const warningCount = violations.filter((v) => v.severity === "warning").length;
  const unconnected = raw.unconnected_items ?? [];

  return {
    present: true,
    passed: errors.length === 0 && unconnected.length === 0,
    errorCount: errors.length,
    warningCount,
    unconnectedCount: unconnected.length,
    errors,
    unconnected,
  };
}

export function isTestPoint(comp: any): boolean {
  return comp?.ftype === "simple_test_point" || /^TP(?:[_0-9]|$)/i.test(String(comp?.name ?? ""));
}

export function distanceMm(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function portSelector(compName: string, portName: string): string {
  return `.${compName} > port.${portName}`;
}

export function toKicadLayer(layer: string, allLayers: string[] = ["F.Cu", "B.Cu"]): string[] {
  if (layer === "all") return allLayers;
  if (layer === "top") return ["F.Cu"];
  if (layer === "bottom") return ["B.Cu"];
  const inner = layer.match(/^inner(\d+)$/i);
  if (inner) return [`In${inner[1]}.Cu`];
  return [layer];
}

export function fromKicadLayer(layer: string): string {
  if (layer === "F.Cu") return "top";
  if (layer === "B.Cu") return "bottom";
  const match = layer.match(/^In(\d+)\.Cu$/i);
  if (match) return `inner${match[1]}`;
  return layer.toLowerCase();
}

export function getKeepoutBox(zone: BoardSpec["keepoutZones"][number]): Box2D {
  return {
    minX: zone.xMm - zone.widthMm / 2,
    maxX: zone.xMm + zone.widthMm / 2,
    minY: zone.yMm - zone.heightMm / 2,
    maxY: zone.yMm + zone.heightMm / 2,
  };
}

export function keepoutMatchesLayer(
  zone: BoardSpec["keepoutZones"][number],
  layer: string,
): boolean {
  return zone.layers.includes("all") || zone.layers.includes(layer);
}

/** Liang-Barsky segment vs. axis-aligned bounding box intersection test. */
export function segmentIntersectsBox(a: Point2D, b: Point2D, box: Box2D, expandMm = 0): boolean {
  const minX = box.minX - expandMm;
  const maxX = box.maxX + expandMm;
  const minY = box.minY - expandMm;
  const maxY = box.maxY + expandMm;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  const edges: Array<[number, number]> = [
    [-dx, a.x - minX],
    [dx, maxX - a.x],
    [-dy, a.y - minY],
    [dy, maxY - a.y],
  ];

  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }

  return t0 <= t1;
}

/** Yields each consecutive numeric wire segment along a `pcb_trace.route`. */
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

    // Skip via-to-wire vertical transitions where both points share the same XY.
    if (a.route_type === "via" && b.route_type === "via") continue;

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

export function getPcbTracesForNet(idx: CircuitIndex, sourceNetId: string): any[] {
  return idx.tracesByNetId.get(sourceNetId) ?? [];
}

export function netRoutedLengthMm(idx: CircuitIndex, netName: string): number | null {
  const net = idx.netByName.get(netName);
  if (!net) return null;

  let total = 0;
  for (const pt of getPcbTracesForNet(idx, net.source_net_id)) {
    total += traceLengthMm(pt);
  }
  return total;
}

export function getPortNetName(idx: CircuitIndex, portId: string): string | undefined {
  const connNetId = idx.connMap.getNetConnectedToId(portId);
  return connNetId ? idx.netNameByConnNetId.get(connNetId) : undefined;
}

export function componentOnNet(
  idx: CircuitIndex,
  sourceCompId: string,
  sourceNetId: string,
): boolean {
  const ports = idx.portsByCompId.get(sourceCompId) ?? [];
  return ports.some((p) => idx.connMap.areIdsConnected(p.source_port_id, sourceNetId));
}

export function componentBridgesNets(
  idx: CircuitIndex,
  sourceCompId: string,
  netAId: string,
  netBId: string,
): boolean {
  const ports = idx.portsByCompId.get(sourceCompId) ?? [];
  let onA = false;
  let onB = false;
  for (const p of ports) {
    if (!onA && idx.connMap.areIdsConnected(p.source_port_id, netAId)) onA = true;
    if (!onB && idx.connMap.areIdsConnected(p.source_port_id, netBId)) onB = true;
    if (onA && onB) return true;
  }
  return false;
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
    pcbCopperPours: [] as any[],
    cadModels: [] as any[],
    sourceNets: [] as any[],
    sourcePorts: [] as any[],
    pcbPorts: [] as any[],
    silkTexts: [] as any[],
    schematicComponents: [] as any[],
    schematicBoxes: [] as any[],
    schematicSheets: [] as any[],
    nativeErrors: [] as any[],
    nativeWarnings: [] as any[],
  };

  const bucketByType: Record<string, any[]> = {
    source_component: buckets.sourceComponents,
    pcb_component: buckets.pcbComponents,
    source_trace: buckets.sourceTraces,
    pcb_trace: buckets.pcbTraces,
    pcb_via: buckets.pcbVias,
    pcb_hole: buckets.pcbHoles,
    pcb_plated_hole: buckets.pcbHoles,
    pcb_copper_pour: buckets.pcbCopperPours,
    cad_component: buckets.cadModels,
    source_net: buckets.sourceNets,
    source_port: buckets.sourcePorts,
    pcb_port: buckets.pcbPorts,
    pcb_silkscreen_text: buckets.silkTexts,
    schematic_component: buckets.schematicComponents,
    schematic_box: buckets.schematicBoxes,
    schematic_sheet: buckets.schematicSheets,
  };

  let pcbBoard: any;
  let hasAutoroutingError = false;

  for (const el of circuitJson) {
    const type = typeof el?.type === "string" ? el.type : "";
    if (type === "pcb_board") {
      pcbBoard ??= el;
      continue;
    }
    if (type === "pcb_autorouting_error") hasAutoroutingError = true;
    if (type.endsWith("_error") || el?.error_type) buckets.nativeErrors.push(el);
    else if (type.endsWith("_warning") || el?.warning_type) buckets.nativeWarnings.push(el);

    bucketByType[type]?.push(el);
  }

  const connMap = getFullConnectivityMapFromCircuitJson(circuitJson);
  const netByName = new Map<string, any>();
  const sourceNetIdSet = new Set<string>();
  const netNameByConnNetId = new Map<string, string>();
  const connNetToSourceNetIds = new Map<string, string[]>();

  for (const net of buckets.sourceNets) {
    if (net?.source_net_id) {
      sourceNetIdSet.add(net.source_net_id);
      const connNetId = connMap.getNetConnectedToId(net.source_net_id);
      if (connNetId) {
        if (net.name && !netNameByConnNetId.has(connNetId)) {
          netNameByConnNetId.set(connNetId, String(net.name));
        }
        const ids = connNetToSourceNetIds.get(connNetId) ?? [];
        ids.push(net.source_net_id);
        connNetToSourceNetIds.set(connNetId, ids);
      }
    }
    if (net?.name) netByName.set(String(net.name), net);
  }

  const portsByCompId = new Map<string, any[]>();
  const sourcePortIdSet = new Set<string>();
  for (const port of buckets.sourcePorts) {
    if (port?.source_port_id) sourcePortIdSet.add(port.source_port_id);
    const list = portsByCompId.get(port.source_component_id) ?? [];
    list.push(port);
    portsByCompId.set(port.source_component_id, list);
  }

  const sourceTraceById = new Map(buckets.sourceTraces.map((st) => [st.source_trace_id, st]));

  // Precompute traces per source_net_id in O(T) instead of scanning all traces per net.
  const tracesByNetId = new Map<string, any[]>();
  const addTraceToNet = (netId: string, pt: any) => {
    const list = tracesByNetId.get(netId) ?? [];
    if (!list.includes(pt)) list.push(pt);
    tracesByNetId.set(netId, list);
  };

  for (const pt of buckets.pcbTraces) {
    const st = sourceTraceById.get(pt.source_trace_id);
    if (Array.isArray(st?.connected_source_net_ids)) {
      for (const netId of st.connected_source_net_ids) addTraceToNet(netId, pt);
    }
    const traceConnId = pt.source_trace_id || pt.pcb_trace_id;
    const connNetId = traceConnId ? connMap.getNetConnectedToId(traceConnId) : undefined;
    if (connNetId) {
      for (const netId of connNetToSourceNetIds.get(connNetId) ?? []) {
        addTraceToNet(netId, pt);
      }
    }
  }

  return {
    raw: circuitJson,
    connMap,
    pcbBoard,
    ...buckets,
    hasAutoroutingError,
    netByName,
    compById: new Map(buckets.sourceComponents.map((c) => [c.source_component_id, c])),
    pcbBySourceId: new Map(buckets.pcbComponents.map((pc) => [pc.source_component_id, pc])),
    pcbPortBySourcePortId: new Map(buckets.pcbPorts.map((pp) => [pp.source_port_id, pp])),
    sourceTraceById,
    portsByCompId,
    sourcePortIdSet,
    sourceNetIdSet,
    tracesByNetId,
    netNameByConnNetId,
  };
}
