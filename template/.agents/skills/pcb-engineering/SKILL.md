---
name: pcb-engineering
description: >-
  Hardware engineering guidelines: research real in-stock components within budget,
  import verified footprints and 3D models, include all fab-ready support circuitry
  (protection, decoupling, pull-ups, test points, silkscreen, thermals), and prove
  electrical behavior via ngspice SPICE simulations.
---

# Hardware Engineering & Fab-Ready Checklist

Every completed board must be **ready to fabricate and assemble** — never omit
the supporting components required for reliable Rev-1 hardware.

## 1. Real Parts, Footprints & 3D Models

- Pick real, in-stock parts (prefer JLCPCB Basic Parts for passives). Derate
  capacitors >=2x working voltage (accounts for X5R/X7R DC-bias loss) and
  resistors >=2x expected power.
- Search & import footprints/3D models into `src/components/`:
  - Batch search multiple parts in parallel: `just search "<part1>" "<part2>" ...`
  - Single search / import / convert: `tsci search "<part>"` | `tsci import "<LCSC_C_NUMBER>"` | `tsci convert <file.kicad_mod>`
- Consult `references/tscircuit-reference.md` for `<board>` DRC/via props, semantic primitives (`<connector>`, `<testpoint>`, `<hole>`), custom footprint courtyards, `pcbPath` routing, and SPICE testbench syntax before reading `node_modules`.
- Verify every IC pinout and polarity (diode cathode, LED, polarized caps, MOSFET
  pinout) against its datasheet. Record every placed designator's MPN, LCSC, and
  unit price in `specs/board.spec.json -> budget.bomCosts`.

## 2. Mandatory Fab-Ready Support Circuitry

- **Power & Protection**:
  - Reverse-polarity protection (Schottky / P-FET) + resettable polyfuse/fuse on external power inputs.
  - ESD/TVS diodes on ALL exposed external connectors (USB D+/D-/VBUS, GPIO, power).
  - **USB-C sink/UFP**: ALWAYS add separate `5.1kΩ` pull-down resistors on BOTH `CC1` and `CC2` to `GND` (required for USB-C PD chargers to supply 5V).
  - Bulk decoupling (`10uF–47uF`) at power entry/regulator outputs + local `100nF` bypass cap directly beside EVERY IC VCC/VDD pin.
  - Ferrite bead / RC filter on analog rails (`VDDA`/`VREF`).
- **Digital & Bring-Up Essentials**:
  - `10kΩ` pull-up + `100nF` cap on `RESET/NRST`; required boot-strap resistors (`BOOT0`/`GPIO0`).
  - `2.2k–4.7kΩ` pull-ups on open-drain buses (I2C SDA/SCL); `22–33Ω` series damping on fast clocks if needed.
  - Crystal load capacitors sized via `C1 = C2 = 2 * (CL - Cstray)` placed right beside MCU oscillator pins.
  - Programming/debug header (SWD/UART) + **test points in moderation**:
    - Place accessible `<testpoint>` pads (`1.0 mm` SMD pad on compact boards, or a clippable loop for `GND` on larger boards) on `GND`, each primary power rail (`VBUS`/`VIN`, regulated outputs), and critical bring-up signals (`RESET/NRST`, key analog sense nodes) where board area allows.
    - **Do not** add stub test points on high-speed differential pairs (USB SS/USB4, Ethernet, HDMI), RF antenna feeds, or every low-priority GPIO. Label every placed test point clearly in silkscreen.
- **SI, Thermals & Physical Polish**:
  - **4-layer stackup** (`Sig/GND/PWR/Sig`) for USB, RF, Ethernet, >20MHz SPI/clocks, or sensitive analog; keep ground plane unbroken and match differential pairs (`<= maxDiffPairSkewMm`).
  - Size power traces per IPC-2221 (`checks/electrical-heuristics.ts` enforces ampacity). Switch LDO -> buck if `P_diss > 0.5W`; add thermal vias under hot QFN/SOT-223 pads.
  - Maintain copper-to-edge clearance (`>= 0.3mm`), mounting-hole screw-head keepouts, clear silkscreen (board name/rev, connector pinouts, pin-1/polarity marks), and fiducials for fine-pitch QFN/BGA parts.
- **Human-Readable Schematic & Reviewability**:
  - Lay out schematics intentionally for human engineers (not just fab DRC): group functional blocks left-to-right with compact `schX`/`schY` coordinates, orient power up / `GND` down, arrange multi-pin IC/connector pins via `schPinArrangement`, and eliminate `schematic_component_styling_warning` label overlaps. See `references/tscircuit-reference.md`.

## 3. Provable SPICE Simulation (`ngspice`)

- Build testbenches in `src/simulations/<name>.sim.circuit.tsx` (`<voltagesource>`,
  `<voltageprobe>`, `<analogsimulation spiceEngine="ngspice" />`) for power filters,
  dividers, regulators, current limiters, and analog stages.
- Declare pass/fail assertions in `specs/board.spec.json -> simulations[]` and prove via `just test`.
