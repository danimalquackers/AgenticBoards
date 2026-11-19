---
name: pcb-engineering
description: >-
  Hardware engineering guidelines: research real in-stock components within budget,
  import verified footprints and 3D models, enforce signal/power integrity and
  thermal limits, and prove electrical behavior via ngspice SPICE simulations.
---

# Component Research, SI/PI/Thermals & SPICE Simulation

## 1. Component Selection, Footprints & 3D Models
- Pick real, in-stock parts fitting voltage/current/thermal ratings (prefer JLCPCB
  Basic Parts for passives; derate capacitors >=2x voltage and resistors >=2x power).
- Search & import footprints + 3D models into `src/components/`:
  - `tsci search "<part or spec>"`
  - `tsci import "<LCSC_C_NUMBER or package>"`
  - `tsci convert <file.kicad_mod>` (for KiCad footprints)
- Verify every IC pinout against its datasheet. Attach `supplierPartNumbers={{ jlcpcb: ["C..."] }}`
  and `cadModel` for connectors/tall parts when 3D accuracy matters.
- Record every placed designator's MPN, LCSC, and unit price in
  `specs/board.spec.json -> budget.bomCosts`.

## 2. Power Conditioning, Signal Integrity & Thermals
- **Power**: Add reverse-polarity + TVS/ESD protection on external ports, bulk
  decoupling (`10uF–47uF`) at power entry/regulators, and local `100nF` bypass caps
  right beside every IC power pin.
- **Signal Integrity**: Use a **4-layer stackup** (`Sig/GND/PWR/Sig`) whenever
  routing USB, Ethernet, RF, >20MHz SPI/clocks, or sensitive analog. Keep high-speed
  return paths unbroken, differential pairs matched, and crystals close to MCU pins.
- **Thermals**: Size power traces per IPC-2221 (`checks/electrical-heuristics.ts`
  checks ampacity automatically). Switch from LDO to buck if $P_{diss} = (V_{in}-V_{out})I > 0.5\text{W}$,
  and add thermal vias/copper pours under hot QFN/SOT-223 pads.

## 3. Provable SPICE Simulation (`ngspice`)
- For power filters, dividers, regulators, current limiters, or analog stages, add
  a testbench in `src/simulations/<name>.sim.circuit.tsx` using `<voltagesource>`,
  `<voltageprobe>`, and `<analogsimulation spiceEngine="ngspice" />`.
- Register pass/fail probe bounds (`avg`, `min`, `max`, `final`, `ripple`) in
  `specs/board.spec.json -> simulations[]` and verify with `npm test`.
- For AC sweeps or custom `.subckt` vendor models, export via `tsci export -f spice`
  and run `ngspice -b` directly.
