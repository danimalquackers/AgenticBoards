---
name: pcb-engineering
description: >-
  Hardware engineering reference: part selection, BOM verification, support
  circuitry, domain layout playbooks, schematic clarity, and ngspice SPICE
  simulation. Use while selecting parts, authoring subcircuits, or building
  testbenches. Do not use for read-only audits (`pcb-review`).
---

# Hardware Engineering & Fab-Ready Reference

Every completed board must be ready to fabricate and assemble on Rev-1.

## Domain Reference Packs (Load Only What Applies)

Read the matching file under `references/` **before** laying out specialized subsystems:

| Subsystem / Design Class                                       | Reference                              |
| :------------------------------------------------------------- | :------------------------------------- |
| tscircuit JSX, footprints, courtyards, schematic layout, SPICE | `references/tscircuit-reference.md`    |
| Buck/boost/charger, motor drivers, rails > 1 A                 | `references/power-electronics.md`      |
| USB-C/2.0/3.x, Ethernet, CAN/RS-485, SPI/SDIO > 20 MHz         | `references/high-speed-interfaces.md`  |
| BLE, Wi-Fi, LoRa, GNSS, PCB/chip antennas, 50 Ω feeds          | `references/rf-wireless.md`            |
| Precision ADCs/DACs, op-amps, sensors, audio, VREF             | `references/analog-mixed-signal.md`    |
| > 48 V DC, AC mains, PoE, galvanic isolation barriers          | `references/high-voltage-isolation.md` |

## 1. Real Parts, Pinouts & Spec Rules

- Pick real, in-stock parts (prefer JLCPCB Basic Parts for passives). Derate capacitors >= 2× working voltage (X5R/X7R DC-bias) and resistors >= 2× power.
- Search and import parts into `src/components/`:
  - Batch search: `just parts-search "<part1>" "<part2>" ...`
  - Audit BOM entries in `specs/board.spec.json`: `just parts-verify`
  - Import/convert footprints: `tscircuit-cli import "<LCSC_C_NUMBER>"` | `tscircuit-cli convert <file.kicad_mod>` (in Nix shells, `tsci` is an alias for `tscircuit-cli`).
- Verify every IC pinout and polarity (diode cathode, LED, polarized cap, MOSFET G/D/S) against its datasheet. Record `mpn`, `lcsc`, `heightMm`, and `unitCostUsd` for every placed designator in `specs/board.spec.json -> budget.bomCosts`.
- Declare specialized rules in `specs/board.spec.json` (`netClasses`, `dimensions.stackup`, `signalIntegrity.buses`) so Freerouting, KiCad DRC, and TDD checks enforce them automatically.

## 2. Baseline Production Support Circuitry

- **Power & Protection**: Reverse-polarity protection + polyfuse/fuse on external power inputs; ESD/TVS diodes on all exposed connectors; bulk decoupling (`10–47 uF`) at entry/regulator outputs + local `100 nF` bypass right beside every IC VCC/VDD pin; ferrite/RC filter on `VDDA`/`VREF`.
- **Digital & Bring-Up**: `10 kΩ` pull-up + `100 nF` cap on `RESET/NRST`; required boot-strap resistors; `2.2–4.7 kΩ` pull-ups on open-drain buses (I2C); crystal load caps sized via `C1 = C2 = 2 * (CL - Cstray)` next to oscillator pins; programming/debug header (SWD/UART).
- **Test Points (In Moderation)**: Place labeled `<testpoint>` pads (`1.0 mm` SMD or loop) on `GND`, primary power rails, and critical bring-up nodes where space permits. Keep high-speed differential pairs and RF feeds completely stub-free.
- **Thermals, Stackup & Polish**: Use 4-layer (`Sig/GND/PWR/Sig`) for USB, RF, Ethernet, > 20 MHz clocks, or precision analog; switch LDO -> buck when `P_diss > 0.5 W`; add thermal vias under hot pads; keep `>= 0.3 mm` copper-to-edge clearance, clear silkscreen (board name/rev, connector pinouts, Pin-1/polarity marks), and fiducials for fine-pitch QFN/BGA.
- **Engineering Schematic**: Frame with `<schematicsheet name="main" sheetSize="A4" />`, group blocks in titled `<schematicbox>` rectangles, and eliminate label overlaps (see `references/tscircuit-reference.md`).

## 3. Provable SPICE Simulation (`ngspice`)

- Build testbenches in `src/simulations/<name>.sim.circuit.tsx` for power filters, dividers, regulators, current limiters, and analog stages.
- Declare pass/fail probe assertions in `specs/board.spec.json -> simulations[]` and prove them via `just test`.
