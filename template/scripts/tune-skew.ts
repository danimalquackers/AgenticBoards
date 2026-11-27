import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Box2D,
  type CircuitIndex,
  getKeepoutBox,
  getPortNetName,
  indexCircuit,
  isDirectRun,
  keepoutMatchesLayer,
  portSelector,
  readJson,
  segmentIntersectsBox,
  writeJson,
} from "../checks/circuit-index";
import { loadOrCompileCircuit, loadSpec } from "../checks/index";
import type { BoardSpec } from "../specs/board-spec.schema";
import type { PcbTracePath, RoutePoint } from "./import-ses";

/**
 * Spec-driven differential-pair length matcher for `src/routing/board-routes.json`.
 * Merges strictly collinear micro-segments on target diff-pair nets, resolves nets via
 * `dist/circuit.json`, and iteratively inserts collision-checked 45-degree trombone
 * meanders across any straight segment of the shorter leg until within `maxDiffPairSkewMm`.
 */

export interface WireSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: string;
  halfW: number;
  net: string;
  routeId: number;
  segIdx: number;
}

export interface PadObstacle {
  box: Box2D;
  layer: string;
  net: string | null;
}

export interface CircleObstacle {
  x: number;
  y: number;
  r: number;
  net: string | null;
}

export interface ObstacleSet {
  pads: PadObstacle[];
  circles: CircleObstacle[];
  segs: WireSegment[];
}

export function routeLengthMm(route: RoutePoint[]): number {
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

function mergeStrictCollinearWires(route: RoutePoint[]): RoutePoint[] {
  if (route.length < 3) return route;
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
      const len1 = Math.hypot(dx1, dy1);
      const len2 = Math.hypot(dx2, dy2);

      if (len1 > 1e-6 && len2 > 1e-6) {
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2) / (len1 * len2);
        const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
        if (cross < 1e-4 && dot > 0.9999) continue;
      }
    }

    out.push(curr);
  }

  out.push(route[route.length - 1]);
  return out;
}

function segToPointDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): boolean {
  const o1 = orient(ax1, ay1, ax2, ay2, bx1, by1);
  const o2 = orient(ax1, ay1, ax2, ay2, bx2, by2);
  const o3 = orient(bx1, by1, bx2, by2, ax1, ay1);
  const o4 = orient(bx1, by1, bx2, by2, ax2, ay2);
  return o1 * o2 < 0 && o3 * o4 < 0;
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
  if (segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)) return 0;
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
    const netName = getPortNetName(idx, port.source_port_id);
    if (netName) map.set(portSelector(comp.name, port.name), netName);
  }

  return map;
}

function resolveRouteNet(entry: PcbTracePath, selectorToNet: Map<string, string>): string {
  const direct = selectorToNet.get(entry.connection);
  if (direct) return direct;
  const netMatch = entry.connection.match(/^net\.([^#]+)/);
  return netMatch ? netMatch[1] : entry.connection;
}

function buildObstacles(
  idx: CircuitIndex | null,
  routes: PcbTracePath[],
  selectorToNet: Map<string, string>,
  spec: BoardSpec,
): ObstacleSet {
  const pads: PadObstacle[] = [];
  const circles: CircleObstacle[] = [];
  const segs: WireSegment[] = [];

  if (idx) {
    for (const el of idx.raw) {
      if (el?.type === "pcb_smtpad" && typeof el.x === "number" && typeof el.y === "number") {
        const hw = typeof el.width === "number" ? el.width / 2 : (el.radius ?? 0.25);
        const hh = typeof el.height === "number" ? el.height / 2 : (el.radius ?? 0.25);
        const netName =
          (el.pcb_port_id ? getPortNetName(idx, el.pcb_port_id) : undefined) ??
          (el.pcb_smtpad_id ? getPortNetName(idx, el.pcb_smtpad_id) : undefined) ??
          null;
        pads.push({
          box: { minX: el.x - hw, maxX: el.x + hw, minY: el.y - hh, maxY: el.y + hh },
          layer: typeof el.layer === "string" ? el.layer : "top",
          net: netName,
        });
      }
    }

    for (const h of idx.pcbHoles) {
      if (typeof h?.x !== "number" || typeof h?.y !== "number") continue;
      const r =
        typeof h.outer_diameter === "number"
          ? h.outer_diameter / 2
          : typeof h.hole_diameter === "number"
            ? h.hole_diameter / 2
            : typeof h.diameter === "number"
              ? h.diameter / 2
              : 0.5;
      const netName = h.pcb_port_id ? (getPortNetName(idx, h.pcb_port_id) ?? null) : null;
      circles.push({ x: h.x, y: h.y, r, net: netName });
    }

    for (const v of idx.pcbVias) {
      if (typeof v?.x !== "number" || typeof v?.y !== "number") continue;
      const r = (v.outer_diameter ?? spec.fabRules.minViaDiameterMm) / 2;
      const netName = v.pcb_via_id ? (getPortNetName(idx, v.pcb_via_id) ?? null) : null;
      circles.push({ x: v.x, y: v.y, r, net: netName });
    }
  }

  for (let routeId = 0; routeId < routes.length; routeId++) {
    const entry = routes[routeId];
    const net = resolveRouteNet(entry, selectorToNet);

    for (let i = 0; i < entry.route.length; i++) {
      const pt = entry.route[i];
      if (pt.route_type === "via") {
        const viaPt = pt as RoutePoint & { outer_diameter?: number; via_diameter?: number };
        circles.push({
          x: pt.x,
          y: pt.y,
          r: (viaPt.outer_diameter ?? viaPt.via_diameter ?? spec.fabRules.minViaDiameterMm) / 2,
          net,
        });
      }
      if (i > 0) {
        const a = entry.route[i - 1];
        const b = pt;
        if (a.route_type === "wire" && b.route_type === "wire" && a.layer === b.layer) {
          segs.push({
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            layer: a.layer ?? "top",
            halfW: (a.width ?? spec.fabRules.minTraceWidthMm) / 2,
            net,
            routeId,
            segIdx: i,
          });
        }
      }
    }
  }

  return { pads, circles, segs };
}

export function segmentClear(
  a: RoutePoint,
  b: RoutePoint,
  layer: string,
  halfW: number,
  net: string,
  spec: BoardSpec,
  obstacles: ObstacleSet,
  selfRouteId: number,
  selfSegIdx: number,
): boolean {
  const clearance = spec.fabRules.minClearanceMm + 0.02;
  const halfBoardW = (spec.dimensions.exactWidthMm ?? spec.dimensions.maxWidthMm) / 2;
  const halfBoardH = (spec.dimensions.exactHeightMm ?? spec.dimensions.maxHeightMm) / 2;
  const edgeLimit = spec.fabRules.minEdgeClearanceMm + halfW;

  for (const pt of [a, b]) {
    if (Math.abs(pt.x) > halfBoardW - edgeLimit || Math.abs(pt.y) > halfBoardH - edgeLimit) {
      return false;
    }
  }

  for (const zone of spec.keepoutZones) {
    if (!keepoutMatchesLayer(zone, layer)) continue;
    if (segmentIntersectsBox(a, b, getKeepoutBox(zone), halfW + clearance)) return false;
  }

  for (const pad of obstacles.pads) {
    if (pad.layer !== layer || pad.net === net) continue;
    if (segmentIntersectsBox(a, b, pad.box, halfW + clearance)) return false;
  }

  for (const c of obstacles.circles) {
    if (c.net === net) continue;
    if (segToPointDist(c.x, c.y, a.x, a.y, b.x, b.y) < c.r + halfW + clearance) return false;
  }

  for (const seg of obstacles.segs) {
    if (seg.layer !== layer) continue;
    // Skip the segment being subdivided and its immediate neighbors on the same route.
    if (seg.routeId === selfRouteId && Math.abs(seg.segIdx - selfSegIdx) <= 1) continue;
    if (seg.net === net && seg.routeId !== selfRouteId) continue;

    if (
      segToSegDist(a.x, a.y, b.x, b.y, seg.x1, seg.y1, seg.x2, seg.y2) <
      seg.halfW + halfW + clearance
    ) {
      return false;
    }
  }

  return true;
}

function tryInsertOneTrombone(
  route: RoutePoint[],
  routeId: number,
  net: string,
  neededMm: number,
  spec: BoardSpec,
  obstacles: ObstacleSet,
): number {
  const candidates: Array<{ idx: number; len: number }> = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    if (a.route_type !== "wire" || b.route_type !== "wire" || a.layer !== b.layer) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= 0.5) candidates.push({ idx: i, len });
  }

  candidates.sort((c1, c2) => c2.len - c1.len);

  for (const { idx: segIdx, len } of candidates) {
    const a = route[segIdx - 1];
    const b = route[segIdx];
    const layer = a.layer ?? "top";
    const width = a.width ?? spec.fabRules.minTraceWidthMm;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -uy;
    const ny = ux;

    // For a 45-degree trapezoid (ramp = h), added length = 2 * (sqrt(2) - 1) * h.
    const margin = Math.min(0.25, len * 0.15);
    const maxAllowedH = Math.min(1.5, (len - 2 * margin - 0.12) / 2);
    if (maxAllowedH < 0.08) continue;

    const targetH = Math.min(neededMm / (2 * (Math.SQRT2 - 1)), maxAllowedH);
    const heightCandidates = [
      ...new Set(
        [targetH, targetH * 0.65, targetH * 0.4, 0.25, 0.12]
          .map((h) => Math.min(h, maxAllowedH))
          .filter((h) => h >= 0.08),
      ),
    ];

    for (const bumpH of heightCandidates) {
      const ramp = bumpH;
      const flat = Math.min(0.4, Math.max(0.1, len - 2 * margin - 2 * ramp));
      const span = 2 * ramp + flat;
      if (span > len - 2 * margin + 1e-6) continue;

      const fracOffsets = [0.5, 0.35, 0.65];
      for (const frac of fracOffsets) {
        const center = Math.max(margin + span / 2, Math.min(len - margin - span / 2, len * frac));
        const s0 = center - span / 2;
        const s1 = s0 + ramp;
        const s2 = s1 + flat;
        const s3 = s2 + ramp;

        for (const dir of [1, -1]) {
          const h = bumpH * dir;
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

          // Check only the newly displaced segments (pts[0..3]) so tight existing pad exits
          // at `a` or `b` do not falsely block a clean middle-of-segment meander.
          const clear =
            segmentClear(pts[0], pts[1], layer, width / 2, net, spec, obstacles, routeId, segIdx) &&
            segmentClear(pts[1], pts[2], layer, width / 2, net, spec, obstacles, routeId, segIdx) &&
            segmentClear(pts[2], pts[3], layer, width / 2, net, spec, obstacles, routeId, segIdx);

          if (!clear) continue;

          route.splice(segIdx, 0, ...pts);
          // Re-index segments on this route after splice so subsequent passes see updated geometry.
          for (let k = obstacles.segs.length - 1; k >= 0; k--) {
            if (obstacles.segs[k].routeId === routeId) obstacles.segs.splice(k, 1);
          }
          for (let i = 1; i < route.length; i++) {
            const p1 = route[i - 1];
            const p2 = route[i];
            if (p1.route_type === "wire" && p2.route_type === "wire" && p1.layer === p2.layer) {
              obstacles.segs.push({
                x1: p1.x,
                y1: p1.y,
                x2: p2.x,
                y2: p2.y,
                layer: p1.layer ?? "top",
                halfW: (p1.width ?? spec.fabRules.minTraceWidthMm) / 2,
                net,
                routeId,
                segIdx: i,
              });
            }
          }

          return 2 * (Math.SQRT2 - 1) * bumpH;
        }
      }
    }
  }

  return 0;
}

export function tuneDiffPairSkew(
  routes: PcbTracePath[],
  spec: BoardSpec,
  idx: CircuitIndex | null,
): { tunedPairs: number; details: string[] } {
  const selectorToNet = buildSelectorToNet(idx);
  const diffNetSet = new Set(spec.signalIntegrity.differentialPairs.flat());

  // Only merge strictly collinear segments on target differential-pair routes.
  for (const entry of routes) {
    if (diffNetSet.has(resolveRouteNet(entry, selectorToNet))) {
      entry.route = mergeStrictCollinearWires(entry.route);
    }
  }

  const obstacles = buildObstacles(idx, routes, selectorToNet, spec);
  const details: string[] = [];
  let tunedPairs = 0;

  for (const [netA, netB] of spec.signalIntegrity.differentialPairs) {
    const entriesA = routes
      .map((entry, routeId) => ({ entry, routeId }))
      .filter(({ entry }) => resolveRouteNet(entry, selectorToNet) === netA);
    const entriesB = routes
      .map((entry, routeId) => ({ entry, routeId }))
      .filter(({ entry }) => resolveRouteNet(entry, selectorToNet) === netB);
    if (entriesA.length === 0 || entriesB.length === 0) continue;

    const initialLenA = entriesA.reduce((s, e) => s + routeLengthMm(e.entry.route), 0);
    const initialLenB = entriesB.reduce((s, e) => s + routeLengthMm(e.entry.route), 0);
    const initialSkew = Math.abs(initialLenA - initialLenB);
    if (initialSkew <= spec.signalIntegrity.maxDiffPairSkewMm) continue;

    const targetNet = initialLenA < initialLenB ? netA : netB;
    const shorterEntries = initialLenA < initialLenB ? entriesA : entriesB;
    let remaining = initialSkew - spec.signalIntegrity.maxDiffPairSkewMm * 0.5;
    let addedTotal = 0;

    for (let pass = 0; pass < 40 && remaining > 0.04; pass++) {
      let addedThisPass = 0;
      for (const { entry, routeId } of shorterEntries) {
        const added = tryInsertOneTrombone(
          entry.route,
          routeId,
          targetNet,
          remaining,
          spec,
          obstacles,
        );
        if (added > 0) {
          addedThisPass += added;
          addedTotal += added;
          remaining -= added;
          break;
        }
      }
      if (addedThisPass <= 0) break;
    }

    if (addedTotal > 0) {
      tunedPairs += 1;
      const newLenA = entriesA.reduce((s, e) => s + routeLengthMm(e.entry.route), 0);
      const newLenB = entriesB.reduce((s, e) => s + routeLengthMm(e.entry.route), 0);
      details.push(
        `[TUNE-SKEW] (${netA}/${netB}): skew ${initialSkew.toFixed(2)}mm -> ${Math.abs(newLenA - newLenB).toFixed(2)}mm (+${addedTotal.toFixed(2)}mm)`,
      );
    } else {
      details.push(
        `[TUNE-SKEW] (${netA}/${netB}): no clear straight segment found for ${remaining.toFixed(2)}mm meander.`,
      );
    }
  }

  return { tunedPairs, details };
}

async function main(): Promise<void> {
  const routesPath = resolve(process.cwd(), process.argv[2] ?? "src/routing/board-routes.json");
  const circuitJsonPath = resolve(process.cwd(), process.argv[3] ?? "dist/circuit.json");

  if (!existsSync(routesPath)) {
    console.error(`[TUNE-SKEW] Routes file not found: ${routesPath}. Run \`just route\` first.`);
    process.exit(1);
  }

  const spec = loadSpec("specs/board.spec.json");
  const routes = readJson<PcbTracePath[]>(routesPath);
  const idx = existsSync(circuitJsonPath)
    ? indexCircuit(readJson<any[]>(circuitJsonPath))
    : indexCircuit(await loadOrCompileCircuit(spec.entrypoint));

  const { tunedPairs, details } = tuneDiffPairSkew(routes, spec, idx);
  for (const line of details) console.log(line);

  if (tunedPairs > 0) {
    writeJson(routesPath, routes);
    console.log(`[TUNE-SKEW] Tuned ${tunedPairs} differential pair(s) -> ${routesPath}`);
  } else {
    console.log("[TUNE-SKEW] All differential pairs within skew budget (no changes written).");
  }
}

if (isDirectRun(import.meta.url)) {
  await main();
}
