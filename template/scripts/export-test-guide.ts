import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CircuitIndex,
  indexCircuit,
  isTestPoint,
  netRoutedLengthMm,
} from "../checks/circuit-index";
import { compileBoard, loadSpec } from "../checks/index";
import type { SimulationRunResult } from "../checks/spice-runner";
import type { BoardSpec } from "../specs/board-spec.schema";

type PowerRail = BoardSpec["powerRails"][number];

interface ProbeEntry {
  probe: string;
  net: string;
  location: string;
  expected: string;
  troubleshooting: string;
}

function mdTable(headers: string[], rows: string[][]): string {
  const divider = headers.map(() => "---");
  const formatRow = (cols: string[]) => `| ${cols.join(" | ")} |`;
  return [formatRow(headers), formatRow(divider), ...rows.map(formatRow)].join("\n");
}

function formatVoltageRange(rail: PowerRail): string {
  const minV = rail.minVoltageV ?? rail.nominalVoltageV * 0.95;
  const maxV = rail.maxVoltageV ?? rail.nominalVoltageV * 1.05;
  return `${rail.nominalVoltageV.toFixed(2)}V (${minV.toFixed(2)}–${maxV.toFixed(2)}V)`;
}

function findConnectedNet(idx: CircuitIndex, compId: string): string {
  const ports = idx.portsByCompId.get(compId) ?? [];

  for (const port of ports) {
    for (const [netName, net] of idx.netByName.entries()) {
      if (idx.connMap.areIdsConnected(port.source_port_id, net.source_net_id)) {
        return netName;
      }
    }
  }

  return "unconnected";
}

function collectProbeEntries(idx: CircuitIndex, spec: BoardSpec): ProbeEntry[] {
  const railByNet = new Map(spec.powerRails.map((r) => [r.net, r]));
  const coveredNets = new Set<string>();
  const entries: ProbeEntry[] = [];

  for (const tp of idx.sourceComponents.filter(isTestPoint)) {
    const net = findConnectedNet(idx, tp.source_component_id);
    const pcb = idx.pcbBySourceId.get(tp.source_component_id);
    const layer = typeof pcb?.layer === "string" ? pcb.layer : "top";
    const location = pcb?.center
      ? `${layer} (${pcb.center.x.toFixed(1)}, ${pcb.center.y.toFixed(1)}) mm`
      : layer;

    coveredNets.add(net);

    if (net === spec.electrical.groundNetName) {
      entries.push({
        probe: `\`${tp.name}\``,
        net: `\`${net}\``,
        location,
        expected: "0.00V ref",
        troubleshooting: "Clip DMM/scope ground lead here",
      });
      continue;
    }

    const rail = railByNet.get(net);
    if (rail) {
      entries.push({
        probe: `\`${tp.name}\``,
        net: `\`${net}\``,
        location,
        expected: formatVoltageRange(rail),
        troubleshooting: "0V: check fuse/EN/polarity; noisy: inspect decoupling cap",
      });
      continue;
    }

    entries.push({
      probe: `\`${tp.name}\``,
      net: `\`${net}\``,
      location,
      expected: "Signal",
      troubleshooting: "Check logic level or waveform with 10x probe",
    });
  }

  // Include declared power rails that lack a dedicated test point so bring-up still covers them.
  for (const rail of spec.powerRails) {
    if (coveredNets.has(rail.net)) continue;

    entries.push({
      probe: "Nearest cap/pin",
      net: `\`${rail.net}\``,
      location: "—",
      expected: formatVoltageRange(rail),
      troubleshooting: "0V: check upstream supply/EN; droop: check current limit",
    });
  }

  return entries;
}

function renderPowerSection(idx: CircuitIndex, spec: BoardSpec): string {
  const gnd = spec.electrical.groundNetName;
  const railList = spec.powerRails.map((r) => `\`${r.net}\``).join(", ");
  const shortCheck = railList
    ? `Check resistance from \`${gnd}\` to ${railList} before applying power. If any rail reads <10 Ω, inspect polarized caps, diodes, and IC pin-1 orientation.`
    : `Check resistance between power input and \`${gnd}\` before applying power. If <10 Ω, inspect polarity and solder bridges.`;

  const entries = collectProbeEntries(idx, spec);
  const table =
    entries.length > 0
      ? mdTable(
          ["Probe", "Net", "Location", "Expected", "If Out of Spec"],
          entries.map((e) => [e.probe, e.net, e.location, e.expected, e.troubleshooting]),
        )
      : "_No power rails or test points declared in `specs/board.spec.json`._";

  return [
    "## 1. Power-Off Short Check",
    "",
    shortCheck,
    "",
    "## 2. Power-On & Probe Reference",
    "",
    "Start with a current-limited bench supply (50–100 mA initial limit) and verify rails in order:",
    "",
    table,
  ].join("\n");
}

function renderSignalSection(idx: CircuitIndex, spec: BoardSpec): string | null {
  const { differentialPairs, highSpeedNets, maxDiffPairSkewMm } = spec.signalIntegrity;
  if (differentialPairs.length === 0 && highSpeedNets.length === 0) return null;

  const blocks = [
    "## 3. High-Speed & Signal Integrity",
    "",
    "Avoid probing controlled-impedance or RF nets with standard 10 pF passive probes; verify continuity power-off and use active probes or protocol diagnostics.",
  ];

  if (differentialPairs.length > 0) {
    const rows = differentialPairs.map(([netA, netB]) => {
      const lenA = netRoutedLengthMm(idx, netA);
      const lenB = netRoutedLengthMm(idx, netB);
      const skew = lenA !== null && lenB !== null ? `${Math.abs(lenA - lenB).toFixed(2)} mm` : "—";
      return [
        `\`${netA}\` / \`${netB}\``,
        lenA !== null ? `${lenA.toFixed(2)} mm` : "—",
        lenB !== null ? `${lenB.toFixed(2)} mm` : "—",
        `${skew} (max ${maxDiffPairSkewMm} mm)`,
      ];
    });

    blocks.push("", mdTable(["Diff Pair", "Length A", "Length B", "Skew"], rows));
  }

  if (highSpeedNets.length > 0) {
    blocks.push("", `High-speed / RF nets: ${highSpeedNets.map((n) => `\`${n}\``).join(", ")}.`);
  }

  return blocks.join("\n");
}

function renderSimulationSection(): string | null {
  const simPath = resolve(process.cwd(), "dist/sim-report.json");
  if (!existsSync(simPath)) return null;

  const results = JSON.parse(readFileSync(simPath, "utf8")) as SimulationRunResult[];
  const rows = results.flatMap((sim) =>
    sim.assertionResults.map((a) => [
      `\`${sim.name}\``,
      `\`${a.probe}\` (${a.metric})`,
      a.actual !== null ? `${a.actual}` : "—",
      `[${a.min ?? "-inf"}, ${a.max ?? "+inf"}]`,
    ]),
  );

  if (rows.length === 0) return null;

  return [
    "## SPICE Reference Baseline",
    "",
    mdTable(["Simulation", "Probe", "Simulated", "Target Bounds"], rows),
  ].join("\n");
}

function buildTestGuide(idx: CircuitIndex, spec: BoardSpec): string {
  const width = idx.pcbBoard?.width ?? spec.dimensions.exactWidthMm ?? spec.dimensions.maxWidthMm;
  const height =
    idx.pcbBoard?.height ?? spec.dimensions.exactHeightMm ?? spec.dimensions.maxHeightMm;
  const layers = idx.pcbBoard?.num_layers ?? spec.dimensions.layers;

  const sections = [
    `# Bring-Up Guide: ${spec.projectName} (rev ${spec.revision})`,
    `${width} × ${height} mm · ${layers}L · ${spec.dimensions.thicknessMm} mm · ${idx.sourceComponents.length} parts`,
    renderPowerSection(idx, spec),
    renderSignalSection(idx, spec),
    renderSimulationSection(),
  ].filter((section): section is string => Boolean(section));

  return `${sections.join("\n\n")}\n`;
}

const outDir = resolve(process.cwd(), "dist/exports");
mkdirSync(outDir, { recursive: true });

const spec = loadSpec("specs/board.spec.json");
const circuitJson = await compileBoard(spec.entrypoint);
const idx = indexCircuit(circuitJson);

writeFileSync(resolve(outDir, "bringup-test-guide.md"), buildTestGuide(idx, spec));
console.log("[DOCS] Wrote dist/exports/bringup-test-guide.md");
