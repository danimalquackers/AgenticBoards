import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getCopperPourNetNames,
  nudgePadCenterVias,
  orderAndFilterSavedPaths,
  type PcbTracePath,
} from "../scripts/import-ses";
import { routeLengthMm, tuneDiffPairSkew } from "../scripts/tune-skew";
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
    const box = getKeepoutBox({ xMm: 0, yMm: 0, widthMm: 4, heightMm: 4 });
    assert.equal(segmentIntersectsBox({ x: -10, y: 0 }, { x: 10, y: 0 }, box, 0.1), true);
    assert.equal(segmentIntersectsBox({ x: -10, y: 5 }, { x: 10, y: 5 }, box, 0.1), false);
  });

  test("checkKeepoutZones flags pass-through trace and embedded via on matching layer", () => {
    const spec = makeBaseSpec({
      keepoutZones: [
        {
          name: "ant",
          xMm: 0,
          yMm: 0,
          widthMm: 4,
          heightMm: 4,
          layers: ["bottom"],
          allowPlacements: false,
          exemptComponents: [],
        },
      ],
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

  test("checkKeepoutZones honors exemptComponents while still blocking top traces", () => {
    const spec = makeBaseSpec({
      keepoutZones: [
        {
          name: "ant",
          xMm: 0,
          yMm: 0,
          widthMm: 6,
          heightMm: 6,
          layers: ["all"],
          allowPlacements: false,
          exemptComponents: ["U1"],
        },
      ],
    });
    const idx = indexCircuit([
      { type: "source_component", source_component_id: "u1", name: "U1", ftype: "simple_chip" },
      {
        type: "pcb_component",
        pcb_component_id: "pu1",
        source_component_id: "u1",
        layer: "top",
        center: { x: 0, y: 0 },
        width: 5,
        height: 5,
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "t_top",
        route: [
          { route_type: "wire", x: -10, y: 0, width: 0.2, layer: "top" },
          { route_type: "wire", x: 10, y: 0, width: 0.2, layer: "top" },
        ],
      },
    ]);

    const findings = checkKeepoutZones(idx, spec);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, "mechanical.keepout.trace");
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

  test("checkIcDecouplingProximity flags powered ICs without power-to-GND caps and skips passive ESD arrays", () => {
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
      { type: "source_port", source_port_id: "u1_vcc", source_component_id: "u1", name: "VCC" },
      {
        type: "source_trace",
        source_trace_id: "st_u1_vcc",
        connected_source_port_ids: ["u1_vcc"],
        connected_source_net_ids: ["n_v3"],
      },
      // Passive ESD diode array (U5) connected only to SIG and GND (no power rail).
      { type: "source_component", source_component_id: "u5", name: "U5", ftype: "simple_chip" },
      {
        type: "pcb_component",
        pcb_component_id: "pu5",
        source_component_id: "u5",
        center: { x: 20, y: 0 },
      },
      { type: "source_port", source_port_id: "u5_io", source_component_id: "u5", name: "IO1" },
      {
        type: "source_trace",
        source_trace_id: "st_u5_io",
        connected_source_port_ids: ["u5_io"],
        connected_source_net_ids: ["n_sig"],
      },
      // Signal capacitor C1 (SIG to GND) does not count as power decoupling.
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
    assert.ok(findings[0].message.includes("U1"));
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

describe("Routing helpers (tune-skew & import-ses)", () => {
  test("tuneDiffPairSkew length-matches multi-pass meanders while avoiding nearby pads", () => {
    const spec = makeBaseSpec({
      signalIntegrity: {
        highSpeedNets: [],
        differentialPairs: [["DP", "DM"]],
        maxDiffPairSkewMm: 0.5,
        maxTraceLengthMm: {},
        buses: [],
      },
    });
    const idx = indexCircuit([
      { type: "source_net", source_net_id: "n_dp", name: "DP" },
      { type: "source_net", source_net_id: "n_dm", name: "DM" },
      { type: "source_component", source_component_id: "j1", name: "J1", ftype: "simple_chip" },
      { type: "source_port", source_port_id: "p_dp", source_component_id: "j1", name: "DP" },
      { type: "source_port", source_port_id: "p_dm", source_component_id: "j1", name: "DM" },
      {
        type: "source_trace",
        source_trace_id: "st_dp",
        connected_source_port_ids: ["p_dp"],
        connected_source_net_ids: ["n_dp"],
      },
      {
        type: "source_trace",
        source_trace_id: "st_dm",
        connected_source_port_ids: ["p_dm"],
        connected_source_net_ids: ["n_dm"],
      },
      // Place an obstacle pad directly above the DM trace (y = +0.5) so meanders must go -Y.
      {
        type: "pcb_smtpad",
        pcb_smtpad_id: "pad_obs",
        x: 0,
        y: 0.6,
        width: 2,
        height: 0.6,
        layer: "top",
      },
    ]);

    const routes: PcbTracePath[] = [
      {
        connection: ".J1 > port.DP",
        route: [
          { route_type: "wire", x: -6, y: 4, width: 0.15, layer: "top" },
          { route_type: "wire", x: 6, y: 4, width: 0.15, layer: "top" },
        ],
      },
      {
        connection: ".J1 > port.DM",
        route: [
          { route_type: "wire", x: -5, y: 0, width: 0.15, layer: "top" },
          { route_type: "wire", x: 5, y: 0, width: 0.15, layer: "top" },
        ],
      },
    ];

    const res = tuneDiffPairSkew(routes, spec, idx);
    assert.equal(res.tunedPairs, 1);
    const skewAfter = Math.abs(routeLengthMm(routes[0].route) - routeLengthMm(routes[1].route));
    assert.ok(skewAfter <= 0.5, `Expected skew <= 0.5mm, got ${skewAfter.toFixed(3)}mm`);
    // Confirm the meander went below y = 0 (away from the obstacle pad at y = +0.6).
    assert.ok(routes[1].route.some((pt) => pt.y < -0.1));
  });

  test("import-ses drops net.<name> keys, orders branches topologically, defers pour nets, and nudges pad vias", () => {
    const idx = indexCircuit([
      { type: "source_net", source_net_id: "n_gnd", name: "GND" },
      { type: "pcb_copper_pour", pcb_copper_pour_id: "pour1", source_net_id: "n_gnd" },
    ]);
    assert.equal(getCopperPourNetNames(idx).has("GND"), true);

    const { accepted, droppedCount } = orderAndFilterSavedPaths([
      {
        netName: "SDA",
        hasBothPorts: false,
        entry: {
          connection: ".R1 > port.pin1",
          route: [
            { route_type: "wire", x: 5, y: 2, width: 0.15, layer: "top" },
            { route_type: "wire", x: 5, y: 0, width: 0.15, layer: "top" },
          ],
        },
      },
      {
        netName: "SDA",
        hasBothPorts: true,
        entry: {
          connection: ".U1 > port.SDA",
          route: [
            { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
            { route_type: "wire", x: 5, y: 0, width: 0.15, layer: "top" },
            { route_type: "wire", x: 10, y: 0, width: 0.15, layer: "top" },
          ],
        },
      },
      {
        netName: "GND",
        hasBothPorts: false,
        entry: {
          connection: "net.GND",
          route: [
            { route_type: "wire", x: 0, y: 0, width: 0.2, layer: "top" },
            { route_type: "wire", x: 1, y: 0, width: 0.2, layer: "top" },
          ],
        },
      },
    ]);

    assert.equal(accepted.length, 2);
    assert.equal(accepted[0].connection, ".U1 > port.SDA");
    assert.equal(accepted[1].connection, ".R1 > port.pin1");
    assert.equal(droppedCount, 1);

    const nudged = nudgePadCenterVias(
      [
        { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
        { route_type: "via", x: 0, y: 0, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: 3, y: 0, width: 0.15, layer: "bottom" },
      ],
      [{ x: 0, y: 0, halfW: 0.2, halfH: 0.2, layer: "top", selector: ".U1 > port.IO9" }],
    );
    const viaPt = nudged.find((p) => p.route_type === "via");
    assert.ok(viaPt && viaPt.x > 0.3, `Expected via nudged off pad center, got x=${viaPt?.x}`);
  });
});
