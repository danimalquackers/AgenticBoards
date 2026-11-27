import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CircuitIndex,
  fromKicadLayer,
  indexCircuit,
  isDirectRun,
  portSelector,
  readJson,
  writeJson,
} from "../checks/circuit-index";
import { loadOrCompileCircuit, loadSpec } from "../checks/index";

type SExpr = string | SExpr[];

interface WireChain {
  layer: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

interface ViaPoint {
  x: number;
  y: number;
  outerMm: number;
  holeMm: number;
}

interface PortAnchor {
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  layer: string | null;
  selector: string;
}

export interface RoutePoint {
  route_type: "wire" | "via";
  x: number;
  y: number;
  width?: number;
  layer?: string;
  from_layer?: string;
  to_layer?: string;
  via_diameter?: number;
  via_hole_diameter?: number;
}

export interface PcbTracePath {
  connection: string;
  route: RoutePoint[];
}

const ENDPOINT_TOL_MM = 0.05;

function parseSexpr(input: string): SExpr[] {
  const stack: SExpr[][] = [[]];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === "(") {
      const list: SExpr[] = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
      i += 1;
    } else if (ch === ")") {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else if (ch === '"') {
      let end = i + 1;
      let str = "";
      while (end < input.length && input[end] !== '"') {
        if (input[end] === "\\" && end + 1 < input.length) {
          str += input[end + 1];
          end += 2;
        } else {
          str += input[end];
          end += 1;
        }
      }
      stack[stack.length - 1].push(str);
      i = end < input.length ? end + 1 : input.length;
    } else {
      let end = i;
      while (end < input.length && !/[\s()"]/.test(input[end])) end += 1;
      stack[stack.length - 1].push(input.slice(i, end));
      i = end;
    }
  }

  return stack[0];
}

function findChild(list: SExpr[], tag: string): SExpr[] | undefined {
  for (const item of list) {
    if (Array.isArray(item) && item[0] === tag) return item;
  }
  return undefined;
}

function toMmScale(routesNode: SExpr[]): number {
  const res = findChild(routesNode, "resolution");
  const unit = typeof res?.[1] === "string" ? res[1] : "um";
  const divisor = Number(res?.[2] ?? 10) || 10;

  if (unit === "mm") return 1 / divisor;
  if (unit === "mil") return 0.0254 / divisor;
  return 1 / (divisor * 1000);
}

function parseViaDims(padstackName: string): { outerMm: number; holeMm: number } {
  const m = padstackName.match(/_(\d+):(\d+)_um$/);
  if (m) return { outerMm: Number(m[1]) / 1000, holeMm: Number(m[2]) / 1000 };
  return { outerMm: 0.6, holeMm: 0.3 };
}

function near(a: { x: number; y: number }, b: { x: number; y: number }, tol = ENDPOINT_TOL_MM) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

function wireToRoutePoints(w: WireChain): RoutePoint[] {
  return w.points.map((pt) => ({
    route_type: "wire",
    x: Number(pt.x.toFixed(4)),
    y: Number(pt.y.toFixed(4)),
    width: w.width,
    layer: w.layer,
  }));
}

function reverseRoute(route: RoutePoint[]): RoutePoint[] {
  return [...route]
    .reverse()
    .map((pt) =>
      pt.route_type === "via"
        ? { ...pt, from_layer: pt.to_layer, to_layer: pt.from_layer }
        : { ...pt },
    );
}

function dedupeWires(wires: WireChain[]): WireChain[] {
  const seen = new Set<string>();
  const unique: WireChain[] = [];

  for (const w of wires) {
    const fwd = `${w.layer}:${w.width}:${w.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(";")}`;
    const rev = `${w.layer}:${w.width}:${[...w.points]
      .reverse()
      .map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)
      .join(";")}`;
    if (seen.has(fwd) || seen.has(rev)) continue;
    seen.add(fwd);
    unique.push(w);
  }

  return unique;
}

/** Stitches connected wires and vias bidirectionally into continuous multi-layer paths. */
function stitchNetRoutes(rawWires: WireChain[], vias: ViaPoint[]): RoutePoint[][] {
  const wires = dedupeWires(rawWires);
  const used = new Set<number>();
  const stitched: RoutePoint[][] = [];

  const extendTail = (route: RoutePoint[]): boolean => {
    const tail = route[route.length - 1];
    const tailLayer = tail.layer ?? tail.to_layer ?? "top";
    const viaAtTail = vias.find((v) => near(v, tail));

    for (let j = 0; j < wires.length; j++) {
      if (used.has(j)) continue;
      const w = wires[j];
      const sameLayer = w.layer === tailLayer;
      if (!sameLayer && !viaAtTail) continue;

      let pts: Array<{ x: number; y: number }> | null = null;
      if (near(tail, w.points[0])) pts = w.points;
      else if (near(tail, w.points[w.points.length - 1])) pts = [...w.points].reverse();
      if (!pts) continue;

      used.add(j);
      if (!sameLayer && viaAtTail) {
        route.push({
          route_type: "via",
          x: Number(viaAtTail.x.toFixed(4)),
          y: Number(viaAtTail.y.toFixed(4)),
          from_layer: tailLayer,
          to_layer: w.layer,
          via_diameter: viaAtTail.outerMm,
          via_hole_diameter: viaAtTail.holeMm,
        });
      }

      const nextPoints = wireToRoutePoints({ ...w, points: pts });
      route.push(...(sameLayer ? nextPoints.slice(1) : nextPoints));
      return true;
    }

    return false;
  };

  for (let startIdx = 0; startIdx < wires.length; startIdx++) {
    if (used.has(startIdx)) continue;
    used.add(startIdx);

    let route = wireToRoutePoints(wires[startIdx]);
    while (extendTail(route)) {}

    // Also extend backward from the original head by reversing, extending, and restoring.
    route = reverseRoute(route);
    while (extendTail(route)) {}
    route = reverseRoute(route);

    stitched.push(route);
  }

  return stitched;
}

function buildPortAnchors(idx: CircuitIndex | null): PortAnchor[] {
  if (!idx) return [];

  const sourcePortById = new Map(idx.sourcePorts.map((p) => [p.source_port_id, p]));
  const padBoundsByPort = new Map<string, { halfW: number; halfH: number; layer: string | null }>();

  for (const el of idx.raw) {
    if (el?.type === "pcb_smtpad" && el.pcb_port_id) {
      padBoundsByPort.set(el.pcb_port_id, {
        halfW: (typeof el.width === "number" ? el.width : 0.4) / 2,
        halfH: (typeof el.height === "number" ? el.height : 0.4) / 2,
        layer: typeof el.layer === "string" ? el.layer : null,
      });
    } else if (el?.type === "pcb_plated_hole" && el.pcb_port_id) {
      const r =
        Math.max(
          typeof el.outer_diameter === "number" ? el.outer_diameter : 0.8,
          typeof el.outer_width === "number" ? el.outer_width : 0.8,
          typeof el.outer_height === "number" ? el.outer_height : 0.8,
        ) / 2;
      padBoundsByPort.set(el.pcb_port_id, { halfW: r, halfH: r, layer: null });
    }
  }

  const anchors: PortAnchor[] = [];
  for (const pp of idx.pcbPorts) {
    if (typeof pp?.x !== "number" || typeof pp?.y !== "number") continue;
    const sp = sourcePortById.get(pp.source_port_id);
    const comp = sp ? idx.compById.get(sp.source_component_id) : undefined;
    if (!comp?.name || !sp?.name) continue;

    const bounds = padBoundsByPort.get(pp.pcb_port_id) ?? { halfW: 0.15, halfH: 0.15, layer: null };
    anchors.push({
      x: pp.x,
      y: pp.y,
      halfW: Math.max(bounds.halfW, 0.1),
      halfH: Math.max(bounds.halfH, 0.1),
      layer: bounds.layer,
      selector: portSelector(comp.name, sp.name),
    });
  }

  return anchors;
}

function findMatchingPort(pt: RoutePoint, anchors: PortAnchor[]): PortAnchor | null {
  let best: { anchor: PortAnchor; dist: number } | null = null;
  const ptLayer = pt.layer ?? pt.from_layer ?? null;

  for (const anchor of anchors) {
    if (anchor.layer && ptLayer && anchor.layer !== ptLayer) continue;
    const dx = Math.abs(pt.x - anchor.x);
    const dy = Math.abs(pt.y - anchor.y);
    if (dx > anchor.halfW + 0.08 || dy > anchor.halfH + 0.08) continue;

    const dist = Math.hypot(dx, dy);
    if (!best || dist < best.dist) best = { anchor, dist };
  }

  return best?.anchor ?? null;
}

function snapRouteEndpoints(
  route: RoutePoint[],
  anchors: PortAnchor[],
): {
  startPort: PortAnchor | null;
  endPort: PortAnchor | null;
} {
  const startPort = route[0] ? findMatchingPort(route[0], anchors) : null;
  const endPort = route[route.length - 1]
    ? findMatchingPort(route[route.length - 1], anchors)
    : null;

  if (startPort && !near(route[0], startPort, 0.005)) {
    route.unshift({
      ...route[0],
      x: Number(startPort.x.toFixed(4)),
      y: Number(startPort.y.toFixed(4)),
    });
  }
  if (endPort && !near(route[route.length - 1], endPort, 0.005)) {
    const tail = route[route.length - 1];
    route.push({ ...tail, x: Number(endPort.x.toFixed(4)), y: Number(endPort.y.toFixed(4)) });
  }

  return { startPort, endPort };
}

export function getCopperPourNetNames(idx: CircuitIndex | null): Set<string> {
  const names = new Set<string>();
  if (!idx || idx.pcbCopperPours.length === 0) return names;

  for (const [netName, net] of idx.netByName.entries()) {
    const hasPour = idx.pcbCopperPours.some(
      (pour) =>
        pour.source_net_id === net.source_net_id ||
        idx.connMap.areIdsConnected(
          pour.source_net_id || pour.pcb_copper_pour_id,
          net.source_net_id,
        ),
    );
    if (hasPour) names.add(netName);
  }

  return names;
}

/**
 * Nudges intermediate vias that land directly on a component pad slightly along
 * an adjacent wire segment so `@tscircuit/core` does not reject them with
 * `has a via at a pad; enable allowViaInPad`.
 */
export function nudgePadCenterVias(route: RoutePoint[], anchors: PortAnchor[]): RoutePoint[] {
  if (anchors.length === 0 || route.length < 3) return route;

  for (let i = 1; i < route.length - 1; i++) {
    const pt = route[i];
    if (pt.route_type !== "via") continue;

    const hitPad = anchors.find(
      (a) => Math.abs(pt.x - a.x) <= a.halfW + 0.02 && Math.abs(pt.y - a.y) <= a.halfH + 0.02,
    );
    if (!hitPad) continue;

    const prev = route[i - 1];
    const next = route[i + 1];
    const candidates = [prev, next]
      .filter((n) => n.route_type === "wire")
      .map((n) => ({ n, dist: Math.hypot(n.x - pt.x, n.y - pt.y) }))
      .sort((a, b) => b.dist - a.dist);

    const best = candidates[0];
    const minShift = Math.hypot(hitPad.halfW, hitPad.halfH) + 0.15;
    if (!best || best.dist <= minShift + 0.05) continue;

    const ratio = minShift / best.dist;
    const nx = Number((pt.x + (best.n.x - pt.x) * ratio).toFixed(4));
    const ny = Number((pt.y + (best.n.y - pt.y) * ratio).toFixed(4));
    pt.x = nx;
    pt.y = ny;

    // Insert a short wire bridge from the pad center to the shifted via on the adjacent layer.
    if (best.n === next && prev.route_type === "wire") {
      route.splice(i, 0, { ...prev, x: nx, y: ny });
      i += 1;
    } else if (best.n === prev && next.route_type === "wire") {
      route.splice(i + 1, 0, { ...next, x: nx, y: ny });
      i += 1;
    }
  }

  return route;
}

export interface NetPathCandidate {
  netName: string;
  entry: PcbTracePath;
  hasBothPorts: boolean;
}

/**
 * Topologically orders saved paths for `@tscircuit/core` `<autoroutingphase>`:
 * - Keeps all port-to-port trunks first.
 * - Iteratively appends port-anchored branches whose tail joins already-accepted copper
 *   on the same net.
 * - Drops dangling stubs and never emits invalid `net.<name>` fallback keys.
 */
export function orderAndFilterSavedPaths(candidates: NetPathCandidate[]): {
  accepted: PcbTracePath[];
  droppedCount: number;
} {
  const accepted: PcbTracePath[] = [];
  const copperByNet = new Map<string, RoutePoint[]>();
  const pending: NetPathCandidate[] = [];

  const recordCopper = (netName: string, route: RoutePoint[]) => {
    const list = copperByNet.get(netName) ?? [];
    list.push(...route);
    copperByNet.set(netName, list);
  };

  for (const c of candidates) {
    if (c.entry.connection.startsWith("net.")) continue;
    if (c.hasBothPorts) {
      accepted.push(c.entry);
      recordCopper(c.netName, c.entry.route);
    } else {
      pending.push(c);
    }
  }

  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      const existing = copperByNet.get(c.netName);
      const tail = c.entry.route[c.entry.route.length - 1];
      if (!existing || !tail) continue;

      const joinsCopper = existing.some((pt) => near(pt, tail, 0.06));
      if (joinsCopper) {
        accepted.push(c.entry);
        recordCopper(c.netName, c.entry.route);
        pending.splice(i, 1);
        progress = true;
      }
    }
  }

  const droppedCount =
    candidates.filter((c) => c.entry.connection.startsWith("net.")).length + pending.length;
  return { accepted, droppedCount };
}

async function main(): Promise<void> {
  const sesPath = resolve(process.cwd(), process.argv[2] ?? "dist/routing/board.ses");
  const outPath = resolve(process.cwd(), process.argv[3] ?? "src/routing/board-routes.json");
  const circuitJsonPath = resolve(process.cwd(), process.argv[4] ?? "dist/circuit.json");

  if (!existsSync(sesPath)) {
    console.error(`[IMPORT-SES] SES file not found: ${sesPath}`);
    process.exit(1);
  }

  const ast = parseSexpr(readFileSync(sesPath, "utf8"));
  const session = findChild(ast, "session");
  const routesNode = session ? findChild(session, "routes") : undefined;
  const networkOut = routesNode ? findChild(routesNode, "network_out") : undefined;

  if (!routesNode || !networkOut) {
    console.error("[IMPORT-SES] Invalid SES structure: missing (routes (network_out ...)).");
    process.exit(1);
  }

  const scale = toMmScale(routesNode);
  let idx: CircuitIndex | null = null;
  if (existsSync(circuitJsonPath)) {
    idx = indexCircuit(readJson<any[]>(circuitJsonPath));
  } else if (existsSync(resolve(process.cwd(), "specs/board.spec.json"))) {
    const spec = loadSpec("specs/board.spec.json");
    idx = indexCircuit(await loadOrCompileCircuit(spec.entrypoint));
  }

  const anchors = buildPortAnchors(idx);
  const pourNets = getCopperPourNetNames(idx);
  const usedConnections = new Set<string>();
  const candidates: NetPathCandidate[] = [];
  let skippedPourNets = 0;

  for (const item of networkOut.slice(1)) {
    if (!Array.isArray(item) || item[0] !== "net" || typeof item[1] !== "string") continue;
    const netName = item[1].replace(/_source_net_\d+$/, "");
    if (pourNets.has(netName)) {
      skippedPourNets += 1;
      continue;
    }

    const vias: ViaPoint[] = [];
    const wires: WireChain[] = [];

    for (const child of item.slice(2)) {
      if (!Array.isArray(child)) continue;

      if (child[0] === "via" && typeof child[1] === "string") {
        const { outerMm, holeMm } = parseViaDims(child[1]);
        vias.push({ x: Number(child[2]) * scale, y: Number(child[3]) * scale, outerMm, holeMm });
      } else if (child[0] === "wire") {
        const pathNode = findChild(child, "path");
        if (!pathNode || typeof pathNode[1] !== "string") continue;

        const coords = pathNode.slice(3).map(Number);
        if (coords.length < 4) continue;

        const points: Array<{ x: number; y: number }> = [];
        for (let i = 0; i + 1 < coords.length; i += 2) {
          points.push({ x: coords[i] * scale, y: coords[i + 1] * scale });
        }
        wires.push({
          layer: fromKicadLayer(pathNode[1]),
          width: Number((Number(pathNode[2]) * scale).toFixed(4)),
          points,
        });
      }
    }

    for (let route of stitchNetRoutes(wires, vias)) {
      let { startPort, endPort } = snapRouteEndpoints(route, anchors);
      if (!startPort && endPort) {
        route = reverseRoute(route);
        [startPort, endPort] = [endPort, startPort];
      }

      route = nudgePadCenterVias(route, anchors);

      const portCandidates = [startPort?.selector, endPort?.selector].filter((s): s is string =>
        Boolean(s),
      );
      const connection = portCandidates.find((s) => !usedConnections.has(s));
      if (!connection) continue;

      usedConnections.add(connection);
      candidates.push({
        netName,
        entry: { connection, route },
        hasBothPorts: Boolean(startPort && endPort),
      });
    }
  }

  const { accepted, droppedCount } = orderAndFilterSavedPaths(candidates);
  writeJson(outPath, accepted);
  console.log(
    `[IMPORT-SES] Imported ${accepted.length} validated paths ` +
      `(${droppedCount} unattached/stub dropped, ${skippedPourNets} copper-pour net(s) deferred) -> ${outPath}`,
  );
}

if (isDirectRun(import.meta.url)) {
  await main();
}
