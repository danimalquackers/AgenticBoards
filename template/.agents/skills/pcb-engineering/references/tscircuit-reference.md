# tscircuit Quick Reference

Use this sheet to understand the basics, and `node_modules/@tscircuit/props/dist/index.d.ts` for a full reference if needed.

## `<board>` DRC, Via & Stackup Props

Keep `<board>` routing tolerances aligned with `specs/board.spec.json -> fabRules` so `auto-local` generates compliant traces and vias on the first pass:

```tsx
<board
  width="50mm"
  height="30mm"
  layers={4}
  thickness="1.6mm"
  autorouter="auto-local"
  defaultTraceWidth="0.16mm"
  minTraceWidth="0.15mm"
  minViaHoleDiameter="0.3mm"
  minViaPadDiameter="0.6mm"
  minBoardEdgeClearance="0.35mm"
  minTraceToPadEdgeClearance="0.15mm"
  minTraceToHoleEdgeClearance="0.15mm"
  minViaEdgeToPadEdgeClearance="0.15mm"
  pcbStyle={{ viaHoleDiameter: "0.3mm", viaPadDiameter: "0.6mm" }}
>
  ...
</board>
```

- `PcbStyle` supports `viaHoleDiameter` and `viaPadDiameter` (set trace widths via `defaultTraceWidth` / `minTraceWidth` on `<board>` or `thickness` on `<trace>`).

## Semantic Components (Avoid `<chip>` Warning Floods)

Use the matching JSX primitive to prevent `source_refdes_convention_warning` and missing-courtyard warnings:

- **Connectors (`J1`, `J_BAT`, `J_DBG`)**: Use `<connector>` or `<pinheader>` instead of `<chip>`.
- **Test points (`TP_GND`, `TP_V3V3`)**: Use `<testpoint name="TP_GND" footprintVariant="pad" padDiameter="1.0mm" pcbX={...} pcbY={...} />`.
- **Non-plated mounting holes (`MH1`, `MH2`)**: Use `<hole name="MH1" pcbX={...} pcbY={...} diameter="2.2mm" />` (use `<platedhole>` only when an electrical ring is required).
- **Passives & discretes**: `<resistor>`, `<capacitor>`, `<inductor>`, `<diode>`, `<led>`, `<mosfet>`, `<transistor>`, `<fuse>`, `<crystal>`.
- **Silkscreen**: `<silkscreentext text="BOARD v1.0" pcbX={0} pcbY={12} fontSize="0.8mm" layer="top" />`.
- **Part numbers**: Pass `manufacturerPartNumber` (MPN) and `supplierPartNumbers={{ jlcpcb: ["C..."] }}` on components so PCBA BOM exports populate cleanly.

## Custom Footprints

- Always include a `<courtyard>` (or `<silkscreenpath>` + `courtyard`) inside custom `<footprint>` JSX so `tscircuit` checks courtyard overlaps accurately without emitting `pcb_component_missing_courtyard_warning`.
- Add stable `key` props when mapping `<smtpad>` arrays in React to keep test logs clean.
- Attach `<cadmodel>` (or standard footprinter strings like `"0402"`, `"0603"`, `"sot23"`, `"qfn32_p0.5_w5_h5"`) so 3D previews and STEP/glTF exports include component bodies.

## Routing: `connections` vs `<trace>`

- **General nets**: `connections={{ pin1: "net.V3V3", pin2: "net.GND" }}` is concise and supported by `checks/constraints.ts`.
- **High-current power buses**: Use `<trace from=".J1 > .VBUS" to=".U1 > .VIN" thickness="0.5mm" />` (or explicit `pcbPath={[{ x, y }, ...]}`) so the autorouter keeps the full bus width.
- **Length-matched differential pairs**: Place source and destination pads aligned on the same axis and provide symmetric `pcbPath` waypoints on `<trace>` for zero skew.

## SPICE Testbenches (`ngspice`)

Place simulation files in `src/simulations/<name>.sim.circuit.tsx` and declare assertions in `specs/board.spec.json -> simulations[]`:

```tsx
export default () => (
  <board schMaxTraceDistance={10}>
    <voltagesource name="V1" voltage="5V" />
    <resistor name="R1" resistance="10k" />
    <resistor name="R2" resistance="10k" />
    <voltageprobe name="VMID_PROBE" connectsTo=".R1 > .pin2" />
    <trace from=".V1 > .pin1" to=".R1 > .pin1" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".V1 > .pin2" to="net.GND" />
    <analogsimulation
      duration="5ms"
      timePerStep="0.1ms"
      spiceEngine="ngspice"
    />
  </board>
);
```

- `<voltagesource>` uses `pin1` (positive) and `pin2` (negative/GND).
- Probe names match case-insensitively in `checks/spice-runner.ts`.
