# Power Electronics Reference

Load this reference when the board includes DC-DC converters (buck, boost, buck-boost), motor drivers, battery chargers, or rails carrying > 1 A.

## 1. Hot-Loop Minimization (Critical for EMI & Stability)

- **Buck converter**: The high-di/dt hot loop is `CIN -> high-side FET -> low-side FET (or catch diode) -> GND -> CIN`. Place the input ceramic capacitor (`CIN`, typically 10 uF + 100 nF) directly across `VIN` and `PGND` pins on the **same layer** with minimal loop area (< 5 mm).
- **Boost converter**: The hot loop is `low-side FET -> diode/sync FET -> COUT -> GND -> low-side FET`. Place `COUT` immediately adjacent to the output diode/SW-out and `PGND` pins.
- **Switch node (`SW` / `PH`)**: Keep the copper polygon wide enough for current, but as **short and compact** as possible to minimize radiated EMI. Never route sensitive analog/feedback traces under or parallel to `SW`.

## 2. Feedback, Current Sense & Grounding

- **Kelvin feedback (`FB`)**: Route `FB` away from the inductor and `SW` node; tap the output rail **after** the output capacitor, not at the inductor pad. Place the feedback divider resistors right beside the IC `FB` pin.
- **Current sense shunts**: Route `ISENSE+` and `ISENSE-` as a tightly coupled differential Kelvin pair from the inside edges of the shunt resistor pads directly to the IC.
- **PGND vs. AGND**: Use a single solid ground plane on Layer 2 (4-layer) and tie the IC's `AGND` and `PGND` pins at a single quiet point (usually the IC thermal pad). Avoid slicing the main ground plane.

## 3. Gate Drives & Motor Bridges

- Route gate-drive (`GATE_H`, `GATE_L`) and bootstrap (`BST`) traces short and wide (0.3–0.5 mm) directly beside their return path (`SW` for high-side, `PGND` for low-side).
- Include series gate resistors (2.2–10 Ω) and gate-to-source pull-downs (10–100 kΩ) so MOSFETs stay safely off during MCU reset.
- Add bulk electrolytic/polymer capacitance + local ceramic decoupling close to every H-bridge half-bridge (`VBUS` to `PGND`).

## 4. Thermals & Copper Sizing

- Declare every power rail in `specs/board.spec.json -> powerRails` with realistic `maxCurrentA`; `checks/electrical-heuristics.ts` enforces IPC-2221 trace widths automatically.
- For power dissipation > 0.5 W in a linear regulator, switch to a synchronous buck.
- Under QFN/DFN/SOT-223 thermal pads, place a grid of thermal vias (0.3 mm drill, 0.5–0.6 mm pad, ~1.0–1.2 mm pitch) connected to an unbroken internal/bottom copper pour.
- Verify ripple, startup overshoot, and efficiency/losses in `src/simulations/` with `ngspice`.
