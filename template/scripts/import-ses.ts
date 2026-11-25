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

/** Stitches connected wires and vias on a net into continuous multi-layer paths. */
function stitchNetRoutes(wires: WireChain[], vias: ViaPoint[]): RoutePoint[][] {
  const used = new Set<number>();
  const stitched: RoutePoint[][] = [];

  for (let startIdx = 0; startIdx < wires.length; startIdx++) {
    if (used.has(startIdx)) continue;
    used.add(startIdx);

    const route = wireToRoutePoints(wires[startIdx]);

    let extended = true;
    while (extended) {
      extended = false;
      const tail = route[route.length - 1];
      const tailLayer = tail.layer ?? tail.to_layer ?? "top";
      const viaAtTail = vias.find((v) => near(v, tail));

      for (let j = 0; j < wires.length; j++) {
        if (used.has(j)) continue;
        const w = wires[j];
        const first = w.points[0];
        const last = w.points[w.points.length - 1];

        const sameLayer = w.layer === tailLayer;
        const canBridge = sameLayer || Boolean(viaAtTail);
        if (!canBridge) continue;

        let pts: Array<{ x: number; y: number }> | null = null;
        if (near(tail, first)) pts = w.points;
        else if (near(tail, last)) pts = [...w.points].reverse();
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
        extended = true;
        break;
      }
    }

    stitched.push(route);
  }

  return stitched;
}

function buildPortLookup(idx: CircuitIndex | null) {
  if (!idx) return [];

  const sourcePortById = new Map(idx.sourcePorts.map((p) => [p.source_port_id, p]));
  const ports: Array<{ x: number; y: number; selector: string }> = [];

  for (const pp of idx.pcbPorts) {
    if (typeof pp?.x !== "number" || typeof pp?.y !== "number") continue;
    const sp = sourcePortById.get(pp.source_port_id);
    const comp = sp ? idx.compById.get(sp.source_component_id) : undefined;
    if (!comp?.name || !sp?.name) continue;
    ports.push({ x: pp.x, y: pp.y, selector: `.${comp.name} > port.${sp.name}` });
  }

  return ports;
}

function pickUniqueConnection(
  netName: string,
  route: RoutePoint[],
  ports: Array<{ x: number; y: number; selector: string }>,
  used: Set<string>,
): string {
  const endpoints = [route[0], route[route.length - 1]].filter(Boolean);

  for (const ep of endpoints) {
    let best: { selector: string; dist: number } | null = null;
    for (const p of ports) {
      const dist = Math.hypot(p.x - ep.x, p.y - ep.y);
      if (dist <= 0.35 && (!best || dist < best.dist)) {
        best = { selector: p.selector, dist };
      }
    }
    if (best && !used.has(best.selector)) {
      used.add(best.selector);
      return best.selector;
    }
  }

  const cleanNet = netName.replace(/_source_net_\d+$/, "");
  let idx = 0;
  let fallback = `net.${cleanNet}`;
  while (used.has(fallback)) {
    idx += 1;
    fallback = `net.${cleanNet}#${idx}`;
  }
  used.add(fallback);
  return fallback;
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
const ports = buildPortLookup(idx);
const usedConnections = new Set<string>();
const tracePaths: PcbTracePath[] = [];

for (const item of networkOut.slice(1)) {
  if (!Array.isArray(item) || item[0] !== "net" || typeof item[1] !== "string") continue;
  const netName = item[1];
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

  for (const route of stitchNetRoutes(wires, vias)) {
    const connection = pickUniqueConnection(netName, route, ports, usedConnections);
    tracePaths.push({ connection, route });
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(tracePaths, null, 2)}\n`);
console.log(`[IMPORT-SES] Imported ${tracePaths.length} stitched paths -> ${outPath}`);
