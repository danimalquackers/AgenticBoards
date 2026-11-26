import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CircuitIndex, indexCircuit } from "../checks/circuit-index";
import { loadSpec } from "../checks/index";
import type { BoardSpec } from "../specs/board-spec.schema";
import type { PcbTracePath, RoutePoint } from "./import-ses";

/**
 * Spec-driven differential-pair length matcher for `src/routing/board-routes.json`.
 * Merges collinear micro-segments, resolves nets via `dist/circuit.json` connectivity,
 * and inserts collision-checked 45-degree trombone meanders on the shorter leg of
 * any pair exceeding `maxDiffPairSkewMm`.
 */
const routesPath = resolve(process.cwd(), process.argv[2] ?? "src/routing/board-routes.json");
const circuitJsonPath = resolve(process.cwd(), process.argv[3] ?? "dist/circuit.json");

interface WireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: string;
  halfW: number;
  net: string;
}

function routeLengthMm(route: RoutePoint[]): number {
  let len = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    if (a.route_type === "wire" && b.route_type === "wire" && a.layer === b.layer) {
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return len;
}

function mergeCollinearWires(route: RoutePoint[]): RoutePoint[] {
  if (route.length <= 2) return route;
  const out: RoutePoint[] = [route[0]];

  for (let i = 1; i < route.length - 1; i++) {
    const prev = out[out.length - 1];
    const curr = route[i];
    const next = route[i + 1];

    if (
      prev.route_type === "wire" &&
      curr.route_type === "wire" &&
      next.route_type === "wire" &&
      prev.layer === curr.layer &&
      curr.layer === next.layer &&
      prev.width === curr.width &&
      curr.width === next.width
    ) {
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      const l1 = Math.hypot(dx1, dy1);
      const l2 = Math.hypot(dx2, dy2);
      if (l1 > 1e-5 && l2 > 1e-5) {
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2) / (l1 * l2);
        const dot = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
        if (cross < 1e-3 && dot > 0.999) continue;
      }
    }

    out.push(curr);
  }

  out.push(route[route.length - 1]);
  return out;
}

function segToPointDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function segToSegDist(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): number {
  return Math.min(
    segToPointDist(ax1, ay1, bx1, by1, bx2, by2),
    segToPointDist(ax2, ay2, bx1, by1, bx2, by2),
    segToPointDist(bx1, by1, ax1, ay1, ax2, ay2),
    segToPointDist(bx2, by2, ax1, ay1, ax2, ay2),
  );
}

function buildSelectorToNet(idx: CircuitIndex | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!idx) return map;

  for (const port of idx.sourcePorts) {
    const comp = idx.compById.get(port.source_component_id);
    if (!comp?.name || !port?.name) continue;
    for (const [netName, net] of idx.netByName.entries()) {
      if (idx.connMap.areIdsConnected(port.source_port_id, net.source_net_id)) {
        map.set(`.${comp.name} > port.${port.name}`, netName);
        break;
      }
    }
  }

  return map;
}

function resolveRouteNet(entry: PcbTracePath, selectorToNet: Map<string, string>): string {
  const direct = selectorToNet.get(entry.connection);
  if (direct) return direct;
  const netMatch = entry.connection.match(/^net\.([^#]+)/);
  return netMatch ? netMatch[1] : entry.connection;
}

function segmentClear(
  a: RoutePoint,
  b: RoutePoint,
  layer: string,
  halfW: number,
  net: string,
  spec: BoardSpec,
  holes: Array<{ x: number; y: number; r: number }>,
  otherSegs: WireSegment[],
): boolean {
  const clearance = spec.fabRules.minClearanceMm;
  const halfBoardW = (spec.dimensions.exactWidthMm ?? spec.dimensions.maxWidthMm) / 2;
  const halfBoardH = (spec.dimensions.exactHeightMm ?? spec.dimensions.maxHeightMm) / 2;
  const edgeLimit = spec.fabRules.minEdgeClearanceMm + halfW;

  for (const pt of [a, b]) {
    if (Math.abs(pt.x) > halfBoardW - edgeLimit || Math.abs(pt.y) > halfBoardH - edgeLimit) {
      return false;
    }
  }

  for (const zone of spec.keepoutZones) {
    const layers = new Set<string>(zone.layers);
    if (!layers.has("all") && !layers.has(layer)) continue;
    const hw = zone.widthMm / 2 + halfW + clearance;
    const hh = zone.heightMm / 2 + halfW + clearance;
    for (const pt of [a, b]) {
      if (Math.abs(pt.x - zone.xMm) < hw && Math.abs(pt.y - zone.yMm) < hh) return false;
    }
  }

  for (const h of holes) {
    if (segToPointDist(h.x, h.y, a.x, a.y, b.x, b.y) < h.r + halfW + clearance) return false;
  }

  for (const seg of otherSegs) {
    if (seg.layer !== layer || seg.net === net) continue;
    if (
      segToSegDist(a.x, a.y, b.x, b.y, seg.x1, seg.y1, seg.x2, seg.y2) <
      seg.halfW + halfW + clearance
    ) {
      return false;
    }
  }

  return true;
}

function tryInsertTrombone(
  route: RoutePoint[],
  net: string,
  neededMm: number,
  spec: BoardSpec,
  holes: Array<{ x: number; y: number; r: number }>,
  otherSegs: WireSegment[],
): boolean {
  let bestIdx = -1;
  let bestLen = 0;

  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    if (a.route_type !== "wire" || b.route_type !== "wire" || a.layer !== b.layer) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestLen < 1.2) return false;

  const a = route[bestIdx - 1];
  const b = route[bestIdx];
  const layer = a.layer ?? "top";
  const width = a.width ?? spec.fabRules.minTraceWidthMm;
  const ux = (b.x - a.x) / bestLen;
  const uy = (b.y - a.y) / bestLen;
  const nx = -uy;
  const ny = ux;

  const maxBumpH = Math.min(neededMm / 2, 1.5);
  const ramp = Math.min(0.3, bestLen * 0.15);
  const flat = Math.min(0.6, bestLen - 2 * ramp - 0.4);
  if (flat <= 0.1 || maxBumpH <= 0.05) return false;

  const mid = bestLen / 2;
  const s0 = mid - flat / 2 - ramp;
  const s1 = mid - flat / 2;
  const s2 = mid + flat / 2;
  const s3 = mid + flat / 2 + ramp;

  for (const dir of [1, -1]) {
    const h = maxBumpH * dir;
    const pts: RoutePoint[] = [
      {
        route_type: "wire",
        x: Number((a.x + ux * s0).toFixed(4)),
        y: Number((a.y + uy * s0).toFixed(4)),
        width,
        layer,
      },
      {
        route_type: "wire",
        x: Number((a.x + ux * s1 + nx * h).toFixed(4)),
        y: Number((a.y + uy * s1 + ny * h).toFixed(4)),
        width,
        layer,
      },
      {
        route_type: "wire",
        x: Number((a.x + ux * s2 + nx * h).toFixed(4)),
        y: Number((a.y + uy * s2 + ny * h).toFixed(4)),
        width,
        layer,
      },
      {
        route_type: "wire",
        x: Number((a.x + ux * s3).toFixed(4)),
        y: Number((a.y + uy * s3).toFixed(4)),
        width,
        layer,
      },
    ];

    const poly = [a, ...pts, b];
    const clear = poly
      .slice(0, -1)
      .every((p, idx) =>
        segmentClear(p, poly[idx + 1], layer, width / 2, net, spec, holes, otherSegs),
      );

    if (clear) {
      route.splice(bestIdx, 0, ...pts);
      return true;
    }
  }

  return false;
}

if (!existsSync(routesPath)) {
  console.error(`[TUNE-SKEW] Routes file not found: ${routesPath}. Run \`just route\` first.`);
  process.exit(1);
}

const spec = loadSpec("specs/board.spec.json");
const routes = JSON.parse(readFileSync(routesPath, "utf8")) as PcbTracePath[];
const idx = existsSync(circuitJsonPath)
  ? indexCircuit(JSON.parse(readFileSync(circuitJsonPath, "utf8")) as any[])
  : null;

for (const entry of routes) {
  entry.route = mergeCollinearWires(entry.route);
}

const selectorToNet = buildSelectorToNet(idx);
const holes = (idx?.pcbHoles ?? [])
  .filter((h) => typeof h?.x === "number" && typeof h?.y === "number")
  .map((h) => ({
    x: h.x as number,
    y: h.y as number,
    r: ((h.hole_diameter ?? h.diameter ?? 1) as number) / 2,
  }));

const allSegs: WireSegment[] = [];
for (const entry of routes) {
  const net = resolveRouteNet(entry, selectorToNet);
  for (let i = 1; i < entry.route.length; i++) {
    const a = entry.route[i - 1];
    const b = entry.route[i];
    if (a.route_type === "wire" && b.route_type === "wire" && a.layer === b.layer) {
      allSegs.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        layer: a.layer ?? "top",
        halfW: (a.width ?? spec.fabRules.minTraceWidthMm) / 2,
        net,
      });
    }
  }
}

let tunedCount = 0;

for (const [netA, netB] of spec.signalIntegrity.differentialPairs) {
  const routesA = routes.filter((r) => resolveRouteNet(r, selectorToNet) === netA);
  const routesB = routes.filter((r) => resolveRouteNet(r, selectorToNet) === netB);
  if (routesA.length === 0 || routesB.length === 0) continue;

  const lenA = routesA.reduce((s, r) => s + routeLengthMm(r.route), 0);
  const lenB = routesB.reduce((s, r) => s + routeLengthMm(r.route), 0);
  const skew = Math.abs(lenA - lenB);
  if (skew <= spec.signalIntegrity.maxDiffPairSkewMm) continue;

  const targetNet = lenA < lenB ? netA : netB;
  const shorter = lenA < lenB ? routesA[0] : routesB[0];
  const needed = skew - spec.signalIntegrity.maxDiffPairSkewMm * 0.5;

  if (tryInsertTrombone(shorter.route, targetNet, needed, spec, holes, allSegs)) {
    tunedCount += 1;
    const newLenA = routesA.reduce((s, r) => s + routeLengthMm(r.route), 0);
    const newLenB = routesB.reduce((s, r) => s + routeLengthMm(r.route), 0);
    console.log(
      `[TUNE-SKEW] (${netA}/${netB}): skew ${skew.toFixed(2)}mm -> ${Math.abs(newLenA - newLenB).toFixed(2)}mm`,
    );
  } else {
    console.warn(
      `[TUNE-SKEW] (${netA}/${netB}): no clear straight segment found for ${needed.toFixed(2)}mm meander.`,
    );
  }
}

writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`);
console.log(`[TUNE-SKEW] Tuned ${tunedCount} differential pair(s) -> ${routesPath}`);
