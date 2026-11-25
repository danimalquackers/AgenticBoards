import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ipc2221MinTraceWidthMm } from "../checks/electrical-heuristics";
import { loadSpec } from "../checks/index";
import type { BoardSpec } from "../specs/board-spec.schema";

/**
 * Sanitizes a `tscircuit`-exported Specctra DSN file (stripping broken pre-routed
 * wiring, injecting `fabRules`, `keepoutZones`, `powerRails` widths, and multi-layer
 * via padstacks), runs headless `freerouting`, and fails loudly on parse errors.
 */
const dsnPath = resolve(process.cwd(), process.argv[2] ?? "dist/exports/board.dsn");
const sesPath = resolve(process.cwd(), process.argv[3] ?? "dist/routing/board.ses");
const passes = process.argv[4] ?? "40";

function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  let inQuotes = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }

  return -1;
}

function extractStructureLayers(dsn: string): string[] {
  const layers: string[] = [];
  for (const match of dsn.matchAll(/\(layer\s+([^\s()"]+)/g)) {
    layers.push(match[1]);
  }
  return layers.length > 0 ? layers : ["F.Cu", "B.Cu"];
}

function mapSpecLayerToKicad(layer: string, allLayers: string[]): string[] {
  if (layer === "all") return allLayers;
  if (layer === "top") return ["F.Cu"];
  if (layer === "bottom") return ["B.Cu"];
  const inner = layer.match(/^inner(\d+)$/i);
  if (inner) return [`In${inner[1]}.Cu`];
  return [layer];
}

function stripWiringScope(dsn: string): string {
  const start = dsn.indexOf("(wiring");
  if (start < 0) return dsn;

  const end = findMatchingParen(dsn, start);
  if (end < 0) return dsn;

  return `${dsn.slice(0, start)}(wiring\n  )${dsn.slice(end + 1)}`;
}

function stripEmptyClassNets(dsn: string): string {
  return dsn.replace(/(\(class\s+"[^"]+"(?:\s+"[^"]*")*)/g, (block) => block.replace(/\s+""/g, ""));
}

function syncFabRules(dsn: string, spec: BoardSpec | null): string {
  if (!spec) return dsn;

  const widthUm = Math.round(spec.fabRules.minTraceWidthMm * 1000);
  const clearanceUm = Math.round(spec.fabRules.minClearanceMm * 1000);
  const ruleStart = dsn.indexOf("(rule");
  if (ruleStart < 0) return dsn;

  const ruleEnd = findMatchingParen(dsn, ruleStart);
  if (ruleEnd < 0) return dsn;

  const ruleBlock = dsn
    .slice(ruleStart, ruleEnd + 1)
    .replace(/\(width\s+\d+(?:\.\d+)?\)/, `(width ${widthUm})`)
    .replace(/\(clearance\s+\d+(?:\.\d+)?\)/, `(clearance ${clearanceUm})`);

  return `${dsn.slice(0, ruleStart)}${ruleBlock}${dsn.slice(ruleEnd + 1)}`;
}

function injectKeepouts(dsn: string, layers: string[], spec: BoardSpec | null): string {
  if (!spec || spec.keepoutZones.length === 0) return dsn;

  const boundaryStart = dsn.indexOf("(boundary");
  if (boundaryStart < 0) return dsn;
  const boundaryEnd = findMatchingParen(dsn, boundaryStart);
  if (boundaryEnd < 0) return dsn;

  const blocks: string[] = [];
  for (const zone of spec.keepoutZones) {
    const x1 = Math.round((zone.xMm - zone.widthMm / 2) * 1000);
    const x2 = Math.round((zone.xMm + zone.widthMm / 2) * 1000);
    const y1 = Math.round((zone.yMm - zone.heightMm / 2) * 1000);
    const y2 = Math.round((zone.yMm + zone.heightMm / 2) * 1000);
    const targetLayers = new Set(zone.layers.flatMap((l) => mapSpecLayerToKicad(l, layers)));

    for (const layer of targetLayers) {
      blocks.push(
        `    (keepout "${zone.name}" (polygon ${layer} 0 ${x1} ${y1} ${x2} ${y1} ${x2} ${y2} ${x1} ${y2} ${x1} ${y1}))`,
      );
    }
  }

  return `${dsn.slice(0, boundaryEnd + 1)}\n${blocks.join("\n")}${dsn.slice(boundaryEnd + 1)}`;
}

function injectPowerRailClasses(dsn: string, spec: BoardSpec | null): string {
  if (!spec || spec.powerRails.length === 0) return dsn;

  const netStart = dsn.indexOf("(network");
  if (netStart < 0) return dsn;
  const netEnd = findMatchingParen(dsn, netStart);
  if (netEnd < 0) return dsn;

  const networkBlock = dsn.slice(netStart, netEnd);
  const dsnNetNames = [...networkBlock.matchAll(/\(net\s+"([^"]+)"/g)].map((m) => m[1]);
  const clearanceUm = Math.round(spec.fabRules.minClearanceMm * 1000);
  const defaultVia = dsn.match(/\bVia\[[^\s()"]+\]/)?.[0];

  const classes: string[] = [];
  for (const rail of spec.powerRails) {
    const reqWidthMm = Math.max(
      ipc2221MinTraceWidthMm(
        rail.maxCurrentA,
        spec.electrical.maxTraceTempRiseC,
        spec.dimensions.copperWeightOz,
      ),
      rail.minTraceWidthMm ?? 0,
    );
    if (reqWidthMm <= spec.fabRules.minTraceWidthMm + 1e-3) continue;

    const matchingNets = dsnNetNames.filter(
      (n) => n === rail.net || n.startsWith(`${rail.net}_source_net_`),
    );
    if (matchingNets.length === 0) continue;

    const widthUm = Math.round(reqWidthMm * 1000);
    const quoted = matchingNets.map((n) => `"${n}"`).join(" ");
    const viaLine = defaultVia ? `      (circuit (use_via "${defaultVia}"))\n` : "";
    classes.push(
      `    (class "rail_${rail.net}" ${quoted}\n${viaLine}      (rule (width ${widthUm}) (clearance ${clearanceUm}))\n    )`,
    );
  }

  if (classes.length === 0) return dsn;
  return `${dsn.slice(0, netEnd)}\n${classes.join("\n")}\n  ${dsn.slice(netEnd)}`;
}

function repairMissingViaPadstacks(
  dsn: string,
  layers: string[],
): { text: string; patched: string[] } {
  const referenced = new Set<string>();
  for (const match of dsn.matchAll(/\bVia\[[^\s()"]+\]/g)) {
    referenced.add(match[0]);
  }

  const missing = [...referenced].filter(
    (name) => !dsn.includes(`(padstack "${name}"`) && !dsn.includes(`(padstack ${name}`),
  );
  if (missing.length === 0) return { text: dsn, patched: [] };

  const padstackDefs = missing.map((name) => {
    const dims = name.match(/_(\d+):(\d+)_um$/);
    const outerUm = dims ? Number(dims[1]) : 600;
    const shapes = layers.map((layer) => `      (shape (circle ${layer} ${outerUm}))`);
    return [`    (padstack "${name}"`, ...shapes, "      (attach off)", "    )"].join("\n");
  });

  const libIdx = dsn.indexOf("(library");
  if (libIdx < 0) return { text: dsn, patched: [] };

  const insertAt = dsn.indexOf("\n", libIdx);
  if (insertAt < 0) return { text: dsn, patched: [] };

  const patchedText = `${dsn.slice(0, insertAt + 1)}${padstackDefs.join("\n")}\n${dsn.slice(insertAt + 1)}`;
  return { text: patchedText, patched: missing };
}

if (!existsSync(dsnPath)) {
  console.error(`[FREEROUTING] DSN file not found: ${dsnPath}`);
  process.exit(1);
}

const specPath = resolve(process.cwd(), "specs/board.spec.json");
const spec = existsSync(specPath) ? loadSpec("specs/board.spec.json") : null;

const rawDsn = readFileSync(dsnPath, "utf8");
const layers = extractStructureLayers(rawDsn);
const cleaned = injectPowerRailClasses(
  injectKeepouts(syncFabRules(stripEmptyClassNets(stripWiringScope(rawDsn)), spec), layers, spec),
  spec,
);
const { text: fixedDsn, patched } = repairMissingViaPadstacks(cleaned, layers);

writeFileSync(dsnPath, fixedDsn);
if (patched.length > 0) {
  console.log(`[FREEROUTING] Added ${layers.length}L DSN via padstack(s): ${patched.join(", ")}`);
}

mkdirSync(dirname(sesPath), { recursive: true });

const proc = spawnSync(
  "freerouting",
  [
    "--gui.enabled=false",
    "-de",
    dsnPath,
    "-do",
    sesPath,
    `--router.autorouter.max_passes=${passes}`,
  ],
  {
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.awt.headless=true`.trim(),
    },
  },
);

const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
const parseFailed =
  combined.includes("DSN structure parsing failed") ||
  combined.includes("Restored tutorial_board.dsn");

if (proc.status !== 0 || parseFailed || !existsSync(sesPath) || statSync(sesPath).size < 600) {
  console.error("[FREEROUTING] Routing failed (DSN parse error or invalid SES output).");
  if (combined.trim()) console.error(combined.trim().slice(-2000));
  process.exit(1);
}

console.log(`[FREEROUTING] Routed session written to ${sesPath}`);
