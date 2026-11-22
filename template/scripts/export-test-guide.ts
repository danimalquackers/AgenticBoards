import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CircuitIndex,
  indexCircuit,
  isTestPoint,
  netRoutedLengthMm,
} from "../checks/circuit-index";
import { loadOrCompileCircuit, loadSpec } from "../checks/index";
import type { SimulationRunResult } from "../checks/spice-runner";
import type { BoardSpec } from "../specs/board-spec.schema";

type PowerRail = BoardSpec["powerRails"][number];

function mdTable(headers: string[], rows: string[][]): string {
  const divider = headers.map(() => "---");
  const row = (cols: string[]) => `| ${cols.join(" | ")} |`;
  return [row(headers), row(divider), ...rows.map(row)].join("\n");
}

function formatVoltageRange(rail: PowerRail): string {
  const minV = rail.minVoltageV ?? rail.nominalVoltageV * 0.95;
  const maxV = rail.maxVoltageV ?? rail.nominalVoltageV * 1.05;
  return `${rail.nominalVoltageV.toFixed(2)}V (${minV.toFixed(2)}–${maxV.toFixed(2)}V)`;
}

function componentNets(idx: CircuitIndex, compId: string): string[] {
  const ports = idx.portsByCompId.get(compId) ?? [];
  const nets = new Set<string>();

  for (const port of ports) {
    for (const [netName, net] of idx.netByName.entries()) {
      if (idx.connMap.areIdsConnected(port.source_port_id, net.source_net_id)) {
        nets.add(netName);
      }
    }
  }

  return [...nets];
}

function bringupHintForSignal(name: string, net: string): [string, string] {
  const key = `${name} ${net}`.toUpperCase();

  if (/(BOOT|IO0|IO9)/.test(key)) {
    return ["Logic (pull-up)", "Hold LOW while pulsing EN/RST to enter bootloader"];
  }
  if (/(^|[_\s])(EN|RST|NRST|RESET)($|[_\s])/.test(key)) {
    return ["Logic HIGH (~VDD)", "Pull LOW briefly to reset MCU; check 10k pull-up"];
  }
  if (/(TX|RX|UART|SWDIO|SWCLK)/.test(key)) {
    return ["3.3V serial/debug", "Connect USB-UART or SWD adapter (match logic level)"];
  }

  return ["Signal", "Check logic level or waveform with 10x probe"];
}

function renderContinuitySection(idx: CircuitIndex, spec: BoardSpec): string {
  const gnd = spec.electrical.groundNetName;
  const checks: string[] = [];

  if (spec.powerRails.length > 0) {
    const rails = spec.powerRails.map((r) => `\`${r.net}\``).join(", ");
    checks.push(
      `- **Rail-to-GND shorts**: Measure resistance from \`${gnd}\` to ${rails}. Expect >1 kΩ (charging caps may climb); if <10 Ω, inspect polarized caps, diodes, and IC pin-1 orientation.`,
    );
  } else {
    checks.push(
      `- **Power-to-GND short**: Measure resistance between power input and \`${gnd}\`. If <10 Ω, inspect polarity and solder bridges before applying power.`,
    );
  }

  const fuses = idx.sourceComponents.filter((c) => c.ftype === "simple_fuse");
  if (fuses.length > 0) {
    const names = fuses.map((f) => `\`${f.name}\``).join(", ");
    checks.push(`- **Fuses / polyfuses** (${names}): Confirm continuity (<1 Ω across terminals).`);
  }

  const inductors = idx.sourceComponents.filter((c) => c.ftype === "simple_inductor");
  if (inductors.length > 0) {
    const names = inductors.map((l) => `\`${l.name}\``).join(", ");
    checks.push(`- **Inductors / ferrites** (${names}): Confirm low DC resistance (<2 Ω).`);
  }

  return ["## 1. Power-Off Continuity & Short Checks", "", ...checks].join("\n");
}

function renderDiodeSection(idx: CircuitIndex, spec: BoardSpec): string | null {
  const diodes = idx.sourceComponents.filter(
    (c) => c.ftype === "simple_diode" || c.ftype === "simple_led",
  );
  if (diodes.length === 0) return null;

  const rows = diodes.map((d) => {
    const name = String(d.name ?? d.source_component_id);
    const bom = spec.budget.bomCosts[name];
    const desc = `${bom?.mpn ?? ""} ${bom?.notes ?? ""}`.toLowerCase();
    const nets = componentNets(idx, d.source_component_id).join(" / ") || "—";

    let expected = "0.5–0.7V fwd / OL rev";
    if (d.ftype === "simple_led") {
      expected = "1.8–3.0V fwd (glows) / OL rev";
    } else if (/tvs|esd|smf|usblc|tpd|rclamp|pesd/.test(desc)) {
      expected = "OL both ways (bidirectional) or >0.5V rev";
    } else if (/schottky|1n58|ss14|ss34|bat54|b5819/.test(desc)) {
      expected = "0.2–0.4V fwd / OL rev";
    }

    return [`\`${name}\``, nets, expected];
  });

  return [
    "## 2. Diode & Polarity Checks (DMM Diode Mode, Power Off)",
    "",
    mdTable(["Part", "Nets", "Expected Drop (Red->Anode, Black->Cathode)"], rows),
  ].join("\n");
}

function renderResistanceSection(idx: CircuitIndex): string | null {
  const resistors = idx.sourceComponents.filter((c) => c.ftype === "simple_resistor");
  const keyResistors = resistors.filter((r) => {
    const text =
      `${r.name ?? ""} ${componentNets(idx, r.source_component_id).join(" ")}`.toUpperCase();
    return /(CC[12]|RD|EN|RST|RESET|BOOT|PROG|FB|DIV|ADC|PULL|I2C|SDA|SCL)/.test(text);
  });

  if (keyResistors.length === 0) return null;

  const rows = keyResistors.slice(0, 12).map((r) => {
    const value = r.display_resistance ?? (r.resistance ? `${r.resistance} Ω` : "—");
    const nets = componentNets(idx, r.source_component_id).join(" – ") || "—";
    return [`\`${r.name}\``, String(value), nets];
  });

  return [
    "## Key Resistance Checks (Power Off)",
    "",
    "Verify critical strap, pull-up, feedback, and sense resistors (in-circuit readings may be slightly lower than nominal due to parallel paths):",
    "",
    mdTable(["Resistor", "Nominal", "Connected Nets"], rows),
  ].join("\n");
}

function renderPowerAndProbeSection(idx: CircuitIndex, spec: BoardSpec): string {
  const railByNet = new Map(spec.powerRails.map((r) => [r.net, r]));
  const coveredNets = new Set<string>();
  const rows: string[][] = [];

  for (const tp of idx.sourceComponents.filter(isTestPoint)) {
    const name = String(tp.name ?? tp.source_component_id);
    const net = componentNets(idx, tp.source_component_id)[0] ?? "unconnected";
    const pcb = idx.pcbBySourceId.get(tp.source_component_id);
    const layer = typeof pcb?.layer === "string" ? pcb.layer : "top";
    const loc = pcb?.center
      ? `${layer} (${pcb.center.x.toFixed(1)}, ${pcb.center.y.toFixed(1)})`
      : layer;

    coveredNets.add(net);

    if (net === spec.electrical.groundNetName) {
      rows.push([`\`${name}\``, `\`${net}\``, loc, "0.00V ref", "Clip DMM/scope ground here"]);
      continue;
    }

    const rail = railByNet.get(net);
    if (rail) {
      const note = rail.notes
        ? rail.notes
        : "0V: check fuse/EN/polarity; >50mVpp ripple: check decoupling";
      rows.push([`\`${name}\``, `\`${net}\``, loc, formatVoltageRange(rail), note]);
      continue;
    }

    const [expected, hint] = bringupHintForSignal(name, net);
    rows.push([`\`${name}\``, `\`${net}\``, loc, expected, hint]);
  }

  for (const rail of spec.powerRails) {
    if (coveredNets.has(rail.net)) continue;
    const note = rail.notes
      ? rail.notes
      : "0V: check upstream supply/EN; droop: check current limit";
    rows.push(["Nearest cap/pin", `\`${rail.net}\``, "—", formatVoltageRange(rail), note]);
  }

  const table =
    rows.length > 0
      ? mdTable(["Probe", "Net", "Location (mm)", "Expected", "Troubleshooting / Notes"], rows)
      : "_No power rails or test points declared in `specs/board.spec.json`._";

  return [
    "## Power-On Voltage, Ripple & Bring-Up Reference",
    "",
    "Apply power via a current-limited bench supply (50–100 mA initial limit). Verify idle current is stable and nothing heats up, then check DC voltage and AC-coupled ripple:",
    "",
    table,
  ].join("\n");
}

function renderSignalSection(idx: CircuitIndex, spec: BoardSpec): string | null {
  const { differentialPairs, highSpeedNets, maxDiffPairSkewMm } = spec.signalIntegrity;
  if (differentialPairs.length === 0 && highSpeedNets.length === 0) return null;

  const blocks = [
    "## High-Speed & Signal Integrity",
    "",
    "Do not probe controlled-impedance or RF lines with standard 10 pF passive probes; verify continuity power-off and use active low-capacitance probes or protocol diagnostics.",
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
    renderContinuitySection(idx, spec),
    renderDiodeSection(idx, spec),
    renderResistanceSection(idx),
    renderPowerAndProbeSection(idx, spec),
    renderSignalSection(idx, spec),
    renderSimulationSection(),
  ].filter((section): section is string => Boolean(section));

  return `${sections.join("\n\n")}\n`;
}

const outDir = resolve(process.cwd(), "dist/exports");
mkdirSync(outDir, { recursive: true });

const spec = loadSpec("specs/board.spec.json");
const circuitJson = await loadOrCompileCircuit(spec.entrypoint);
const idx = indexCircuit(circuitJson);

writeFileSync(resolve(outDir, "bringup-test-guide.md"), buildTestGuide(idx, spec));
console.log("[DOCS] Wrote dist/exports/bringup-test-guide.md");
