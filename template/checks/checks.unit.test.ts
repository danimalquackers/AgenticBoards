import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type BoardSpec, BoardSpecSchema } from "../specs/board-spec.schema";
import {
  fromKicadLayer,
  getKeepoutBox,
  indexCircuit,
  segmentIntersectsBox,
  toKicadLayer,
} from "./circuit-index";
import { checkKeepoutZones } from "./constraints";
import {
  checkBuses,
  checkFloatingPins,
  checkIcDecouplingProximity,
  checkNetClassWidths,
} from "./electrical-heuristics";
import { summarizeFindings } from "./index";
import { ipc2221MinTraceWidthMm, resolveNetClassRules } from "./net-rules";
import {
  computeMetric,
  evaluateAssertion,
  parseProbeValues,
  runSingleSimulation,
} from "./spice-runner";

function makeBaseSpec(overrides: Partial<BoardSpec> = {}): BoardSpec {
  return BoardSpecSchema.parse({
    projectName: "unit-test-board",
    description: "Synthetic board for unit testing",
    dimensions: { maxWidthMm: 50, maxHeightMm: 50, layers: 2 },
    budget: { maxBomUsd: 20 },
    ...overrides,
  });
}

describe("BoardSpecSchema validation & cross-field rules", () => {
  test("applies nested schema defaults consistently", () => {
    const spec = makeBaseSpec();
    assert.equal(spec.fabRules.fabHouse, "JLCPCB");
    assert.equal(spec.electrical.requireGroundNet, true);
    assert.deepEqual(spec.signalIntegrity.buses, []);
    assert.deepEqual(spec.netClasses, []);
  });

  test("rejects invalid regex namePattern and inconsistent dimensions/via/rail bounds", () => {
    assert.throws(() =>
      makeBaseSpec({
        requiredComponents: [{ description: "bad", namePattern: "[unclosed", minCount: 1 }],
      }),
    );

    assert.throws(() =>
      BoardSpecSchema.parse({
        projectName: "bad-dims",
        description: "exact > max",
        dimensions: { maxWidthMm: 40, maxHeightMm: 40, exactWidthMm: 50, layers: 2 },
        budget: { maxBomUsd: 10 },
      }),
    );

    assert.throws(() =>
      BoardSpecSchema.parse({
        projectName: "bad-via",
        description: "via diameter <= drill",
        dimensions: { maxWidthMm: 40, maxHeightMm: 40, layers: 2 },
        fabRules: { minViaDrillMm: 0.4, minViaDiameterMm: 0.4 },
        budget: { maxBomUsd: 10 },
      }),
    );

    assert.throws(() =>
      BoardSpecSchema.parse({
        projectName: "bad-keepout-layer",
        description: "inner1 on 2-layer board",
        dimensions: { maxWidthMm: 40, maxHeightMm: 40, layers: 2 },
        keepoutZones: [{ name: "k1", xMm: 0, yMm: 0, widthMm: 5, heightMm: 5, layers: ["inner1"] }],
        budget: { maxBomUsd: 10 },
      }),
    );
  });
});

describe("Net rules & layer mapping", () => {
  test("resolveNetClassRules prioritizes explicit netClasses and synthesizes rail classes", () => {
    const spec = makeBaseSpec({
      powerRails: [
        { net: "VBUS", nominalVoltageV: 5, maxCurrentA: 3, requiresDecoupling: true },
        {
          net: "HV_48V",
          nominalVoltageV: 48,
          maxCurrentA: 0.2,
          minClearanceMm: 0.6,
          requiresDecoupling: true,
        },
        { net: "SIG_3V3", nominalVoltageV: 3.3, maxCurrentA: 0.05, requiresDecoupling: true },
      ],
      netClasses: [
        { name: "USB_DIFF", nets: ["USB_DP", "USB_DM"], trackWidthMm: 0.2, clearanceMm: 0.15 },
      ],
    });

    const rules = resolveNetClassRules(spec);
    assert.deepEqual(
      rules.map((r) => r.name),
      ["USB_DIFF", "rail_VBUS", "rail_HV_48V"],
    );
    assert.ok(rules[1].trackWidthMm >= ipc2221MinTraceWidthMm(3, 10, 1));
    assert.equal(rules[2].clearanceMm, 0.6);
  });

  test("round-trips KiCad and tscircuit layer names", () => {
    assert.deepEqual(toKicadLayer("top"), ["F.Cu"]);
    assert.deepEqual(toKicadLayer("inner2"), ["In2.Cu"]);
    assert.equal(fromKicadLayer("B.Cu"), "bottom");
    assert.equal(fromKicadLayer("In1.Cu"), "inner1");
  });
});

describe("Geometry & keepout checks", () => {
  test("segmentIntersectsBox detects pass-through traces whose endpoints lie outside the box", () => {
    const box = getKeepoutBox({
      name: "ant",
      xMm: 0,
      yMm: 0,
      widthMm: 4,
      heightMm: 4,
      layers: ["all"],
    });
    assert.equal(segmentIntersectsBox({ x: -10, y: 0 }, { x: 10, y: 0 }, box, 0.1), true);
    assert.equal(segmentIntersectsBox({ x: -10, y: 5 }, { x: 10, y: 5 }, box, 0.1), false);
  });

  test("checkKeepoutZones flags pass-through trace and embedded via on matching layer", () => {
    const spec = makeBaseSpec({
      keepoutZones: [{ name: "ant", xMm: 0, yMm: 0, widthMm: 4, heightMm: 4, layers: ["bottom"] }],
    });
    const idx = indexCircuit([
      {
        type: "pcb_trace",
        pcb_trace_id: "t_pass",
        route: [
          { route_type: "wire", x: -10, y: 0, width: 0.2, layer: "bottom" },
          { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "bottom" },
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "t_via",
        route: [{ route_type: "via", x: 0, y: 0, from_layer: "top", to_layer: "bottom" }],
      },
    ]);

    const findings = checkKeepoutZones(idx, spec);
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.id === "mechanical.keepout.trace"));
  });
});

describe("Electrical heuristics regressions", () => {
  test("checkFloatingPins flags a pin that only has a placed pcb_port/pad and no peer port", () => {
    const spec = makeBaseSpec();
    const idx = indexCircuit([
      { type: "source_component", source_component_id: "c1", name: "U1", ftype: "simple_chip" },
      { type: "source_port", source_port_id: "sp1", source_component_id: "c1", name: "NC_PIN" },
      { type: "pcb_port", pcb_port_id: "pp1", source_port_id: "sp1", x: 0, y: 0 },
    ]);

    const findings = checkFloatingPins(idx, spec);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "electrical.pin.unconnected");
  });

  test("checkIcDecouplingProximity ignores signal capacitors not bridging a power rail to GND", () => {
    const spec = makeBaseSpec({
      powerRails: [
        { net: "V3V3", nominalVoltageV: 3.3, maxCurrentA: 0.5, requiresDecoupling: true },
      ],
    });
    const idx = indexCircuit([
      { type: "source_net", source_net_id: "n_gnd", name: "GND" },
      { type: "source_net", source_net_id: "n_v3", name: "V3V3" },
      { type: "source_net", source_net_id: "n_sig", name: "SIG" },
      { type: "source_component", source_component_id: "u1", name: "U1", ftype: "simple_chip" },
      {
        type: "pcb_component",
        pcb_component_id: "pu1",
        source_component_id: "u1",
        center: { x: 0, y: 0 },
      },
      {
        type: "source_component",
        source_component_id: "c1",
        name: "C1",
        ftype: "simple_capacitor",
      },
      {
        type: "pcb_component",
        pcb_component_id: "pc1",
        source_component_id: "c1",
        center: { x: 1, y: 0 },
      },
      { type: "source_port", source_port_id: "c1_p1", source_component_id: "c1", name: "pin1" },
      { type: "source_port", source_port_id: "c1_p2", source_component_id: "c1", name: "pin2" },
      {
        type: "source_trace",
        source_trace_id: "st1",
        connected_source_port_ids: ["c1_p1"],
        connected_source_net_ids: ["n_sig"],
      },
      {
        type: "source_trace",
        source_trace_id: "st2",
        connected_source_port_ids: ["c1_p2"],
        connected_source_net_ids: ["n_gnd"],
      },
    ]);

    const caps = idx.sourceComponents.filter((c) => c.ftype === "simple_capacitor");
    const findings = checkIcDecouplingProximity(idx, spec, caps);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "pi.decoupling.ic_missing");
  });

  test("checkBuses detects missing I2C pull-up and checkNetClassWidths enforces netclass trackWidthMm", () => {
    const spec = makeBaseSpec({
      powerRails: [
        { net: "V3V3", nominalVoltageV: 3.3, maxCurrentA: 0.5, requiresDecoupling: false },
      ],
      netClasses: [{ name: "RF", nets: ["RF_OUT"], trackWidthMm: 0.35 }],
      signalIntegrity: {
        highSpeedNets: [],
        differentialPairs: [],
        maxDiffPairSkewMm: 0.5,
        maxTraceLengthMm: {},
        buses: [{ name: "I2C0", protocol: "i2c", nets: ["SDA"], pullUpRail: "V3V3" }],
      },
    });
    const idx = indexCircuit([
      { type: "source_net", source_net_id: "n_v3", name: "V3V3" },
      { type: "source_net", source_net_id: "n_sda", name: "SDA" },
      { type: "source_net", source_net_id: "n_rf", name: "RF_OUT" },
      { type: "source_trace", source_trace_id: "st_rf", connected_source_net_ids: ["n_rf"] },
      {
        type: "pcb_trace",
        pcb_trace_id: "pt_rf",
        source_trace_id: "st_rf",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
          { route_type: "wire", x: 5, y: 0, width: 0.15, layer: "top" },
        ],
      },
    ]);

    assert.equal(checkBuses(idx, spec)[0]?.id, "electrical.bus.missing_pullup");
    assert.equal(checkNetClassWidths(idx, spec)[0]?.id, "si.netclass.trace_too_narrow");
  });
});

describe("SPICE parser & summary helpers", () => {
  test("parseProbeValues ignores blank lines and distinguishes V1 from V10", () => {
    const stdout = [
      "Running simulation for V1 and V10...",
      "time,v(V10),v(V1)",
      "0.0,10.0,3.3",
      "",
      "0.1,10.2,3.4",
      "   ",
    ].join("\n");

    const v1 = parseProbeValues(stdout, "V1");
    const v10 = parseProbeValues(stdout, "V10");
    assert.deepEqual(v1, [3.3, 3.4]);
    assert.deepEqual(v10, [10.0, 10.2]);
    assert.equal(computeMetric([1, 2, 3.3, 3.5], "ripple")?.toFixed(2), "0.20");
    assert.equal(
      evaluateAssertion(stdout, { probe: "V1", metric: "avg", min: 3.3, max: 3.4, unit: "V" })
        .passed,
      true,
    );
  });

  test("runSingleSimulation surfaces spawn errors cleanly", () => {
    const res = runSingleSimulation(
      {
        name: "buck",
        file: "src/simulations/buck.sim.circuit.tsx",
        engine: "ngspice",
        assertions: [],
      },
      process.cwd(),
      () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn ENOENT") }),
    );
    assert.equal(res.passed, false);
    assert.equal(res.error, "spawn ENOENT");
  });

  test("summarizeFindings groups and sorts errors before warnings", () => {
    const grouped = summarizeFindings([
      { id: "w1", category: "drc", severity: "warning", message: "warn" },
      { id: "e1", category: "fab", severity: "error", message: "err1" },
      { id: "e1", category: "fab", severity: "error", message: "err2" },
    ]);
    assert.equal(grouped[0].id, "e1");
    assert.equal(grouped[0].count, 2);
    assert.equal(grouped[1].id, "w1");
  });
});
