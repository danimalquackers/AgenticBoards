# RF & Wireless Reference

Load this reference when the board includes an RF transceiver, wireless module (ESP32, nRF52/53, STM32WL, SX1262), chip/PCB antenna, or coax connector (U.FL / SMA).

## 1. Antenna Placement & Keepout Zones

- Place PCB/chip antennas or wireless module antenna overhangs at a **board corner or outer edge**, away from metal enclosures, batteries, tall connectors, and switching regulators.
- Define an explicit `keepoutZones` entry in `specs/board.spec.json` covering the copper-free antenna overhang/clearance region. Use `"layers": ["all"]` only when the zone lies **outside** the wireless module's own `pcb_component` courtyard; if the module footprint extends over the antenna region on `top`, omit `"top"` (e.g. `["inner1", "inner2", "bottom"]`) so KiCad DRC and `checks/constraints.ts` do not flag the module's own courtyard.
- Follow the module datasheet's exact overhang/ground-plane clearance dimensions (typically 5–15 mm free of copper).

## 2. 50 Ω Feedline & Matching Network

- Route the RF feed from the transceiver/module RF pin to the antenna/connector as a short, straight **50 Ω coplanar waveguide with ground (CPWG)** on the outer layer over a solid GND plane.
- Always include a **pi-matching network** (series component + two shunt-to-GND 0402 pads) directly at the antenna feed, even if initially populated with a `0 Ω` jumper and two DNI shunt pads.
- Declare the RF net in `specs/board.spec.json -> netClasses` (with the 50 Ω trace width from your stackup) and in `signalIntegrity.highSpeedNets` (prevents accidental test-point stubs).

## 3. Ground Stitching & Isolation

- Fence both sides of the 50 Ω RF feedline and the perimeter of the RF section with **GND stitching vias** spaced `<= λ/20` (for 2.4 GHz in FR-4, `<= 3 mm` pitch).
- Keep switching regulators, motor drivers, and high-speed digital buses physically separated from the RF front-end.
- Place the RF crystal immediately next to the transceiver `XIN`/`XOUT` pins with a solid GND pour underneath and zero noisy traces crossing beneath it.
- Supply the RF rail through a clean, low-noise LDO with a ferrite bead + 100 nF + 10 pF/100 pF RF bypass caps right at each `VDD_RF` pin.
