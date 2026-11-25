import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { indexCircuit } from "../checks/circuit-index";
import { loadSpec } from "../checks/index";
import type { BoardSpec } from "../specs/board-spec.schema";
import type { PcbTracePath, RoutePoint } from "./import-ses";

/**
 * Spec-driven differential-pair length matcher for `src/routing/board-routes.json`.
 * Inserts collision-checked 45-degree trombone meanders on the shorter leg of any
 * pair in `specs/board.spec.json -> signalIntegrity.differentialPairs` exceeding
 * `maxDiffPairSkewMm`.
 */
const routesPath = resolve(process.cwd(), process.argv[2] ?? "src/routing/board-routes.json");
const circuitJsonPath = resolve(process.cwd(), process.argv[3] ?? "dist/circuit.json");

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

function pointBlocked(
  x: number,
  y: number,
  layer: string,
  clearance: number,
  spec: BoardSpec,
  holes: Array<{ x: number; y: number; r: number }>,
): boolean {
  const halfW = (spec.dimensions.exactWidthMm ?? spec.dimensions.maxWidthMm) / 2;
  const halfH = (spec.dimensions.exactHeightMm ?? spec.dimensions.maxHeightMm) / 2;
  const edge = spec.fabRules.minEdgeClearanceMm + clearance;

  if (Math.abs(x) > halfW - edge || Math.abs(y) > halfH - edge) return true;

  for (const zone of spec.keepoutZones) {
    const layers = new Set<string>(zone.layers);
    if (!layers.has("all") && !layers.has(layer)) continue;
    const hw = zone.widthMm / 2 + clearance;
    const hh = zone.heightMm / 2 + clearance;
    if (Math.abs(x - zone.xMm) < hw && Math.abs(y - zone.yMm) < hh) return true;
  }

  for (const h of holes) {
    if (Math.hypot(x - h.x, y - h.y) < h.r + clearance) return true;
  }

  return false;
}

function tryInsertTrombone(
  route: RoutePoint[],
  neededMm: number,
  spec: BoardSpec,
  holes: Array<{ x: number; y: number; r: number }>,
): boolean {
  const clearance = spec.fabRules.minClearanceMm + spec.fabRules.minTraceWidthMm;

  // Find the longest straight horizontal or vertical wire segment.
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

  // Each 45-degree bump of height `h` adds `2 * h * (1 - 1/sqrt(2))` -> use flat-top trombone adding `2*h`.
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

    if (pts.every((p) => !pointBlocked(p.x, p.y, layer, clearance, spec, holes))) {
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

const holes = (idx?.pcbHoles ?? [])
  .filter((h) => typeof h?.x === "number" && typeof h?.y === "number")
  .map((h) => ({
    x: h.x as number,
    y: h.y as number,
    r: ((h.hole_diameter ?? h.diameter ?? 1) as number) / 2,
  }));

const matchNet = (entry: PcbTracePath, netName: string) =>
  entry.connection === `net.${netName}` ||
  entry.connection.startsWith(`net.${netName}#`) ||
  entry.connection.includes(`.${netName}`);

let tunedCount = 0;

for (const [netA, netB] of spec.signalIntegrity.differentialPairs) {
  const routesA = routes.filter((r) => matchNet(r, netA));
  const routesB = routes.filter((r) => matchNet(r, netB));
  if (routesA.length === 0 || routesB.length === 0) continue;

  const lenA = routesA.reduce((s, r) => s + routeLengthMm(r.route), 0);
  const lenB = routesB.reduce((s, r) => s + routeLengthMm(r.route), 0);
  const skew = Math.abs(lenA - lenB);

  if (skew <= spec.signalIntegrity.maxDiffPairSkewMm) continue;

  const shorter = lenA < lenB ? routesA[0] : routesB[0];
  const needed = skew - spec.signalIntegrity.maxDiffPairSkewMm * 0.5;

  if (tryInsertTrombone(shorter.route, needed, spec, holes)) {
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
