import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type CircuitIndex, indexCircuit } from "../checks/circuit-index";

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
      while (end < input.length && input[end] !== '"') end += 1;
      stack[stack.length - 1].push(input.slice(i + 1, end));
      i = end + 1;
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

function mapLayer(kicadLayer: string): string {
  if (kicadLayer === "F.Cu") return "top";
  if (kicadLayer === "B.Cu") return "bottom";
  const inner = kicadLayer.match(/^In(\d+)\.Cu$/i);
  if (inner) return `inner${inner[1]}`;
  return kicadLayer.toLowerCase();
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

    const bounds = padBoundsByPort.get(pp.pcb_port_id) ?? { halfW: 0.35, halfH: 0.35, layer: null };
    anchors.push({
      x: pp.x,
      y: pp.y,
      halfW: Math.max(bounds.halfW, 0.35),
      halfH: Math.max(bounds.halfH, 0.35),
      layer: bounds.layer,
      selector: `.${comp.name} > port.${sp.name}`,
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
    if (dx > anchor.halfW + 0.15 || dy > anchor.halfH + 0.15) continue;

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
const idx = existsSync(circuitJsonPath)
  ? indexCircuit(JSON.parse(readFileSync(circuitJsonPath, "utf8")) as any[])
  : null;
const anchors = buildPortAnchors(idx);
const usedConnections = new Set<string>();
const trunks: PcbTracePath[] = [];
const branches: PcbTracePath[] = [];

for (const item of networkOut.slice(1)) {
  if (!Array.isArray(item) || item[0] !== "net" || typeof item[1] !== "string") continue;
  const netName = item[1].replace(/_source_net_\d+$/, "");
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
        layer: mapLayer(pathNode[1]),
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

    const candidates = [startPort?.selector, endPort?.selector].filter((s): s is string =>
      Boolean(s),
    );
    let connection = candidates.find((s) => !usedConnections.has(s));

    if (!connection) {
      let n = 0;
      connection = `net.${netName}`;
      while (usedConnections.has(connection)) {
        n += 1;
        connection = `net.${netName}#${n}`;
      }
    }

    usedConnections.add(connection);
    const entry: PcbTracePath = { connection, route };
    if (startPort && endPort) trunks.push(entry);
    else branches.push(entry);
  }
}

const tracePaths = [...trunks, ...branches];
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(tracePaths, null, 2)}\n`);
console.log(
  `[IMPORT-SES] Imported ${tracePaths.length} stitched paths (${trunks.length} port-to-port, ${branches.length} branches) -> ${outPath}`,
);
