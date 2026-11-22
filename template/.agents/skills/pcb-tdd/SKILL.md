---
name: pcb-tdd
description: >-
  Mandatory Test-Driven Hardware Development workflow: interview the user to
  clarify unspecified constraints, model every requirement in `specs/board.spec.json`
  and `tests/board.constraints.test.ts`, confirm those tests fail before writing
  circuit code, launch the live preview, and iterate until every check passes.
---

# Test-Driven PCB Design & Live Preview

Treat every PCB requirement as an executable contract written **before** any
circuit code exists. Never start placing components in `src/` until all
ambiguities are resolved and all requirements are locked into failing tests.

## Phase 1: Requirements Discovery

Before editing any files, audit the user's request against this checklist and
**ask concise clarifying questions** for any critical requirement that is missing
or ambiguous:

- **Mechanical & Enclosure**: Exact or maximum `width × height` (mm), layer count
  (2 vs 4), mounting hole positions & screw sizes (e.g., M2/M3), connector edges,
  tall-component height limits, or antenna/standoff keepout zones.
- **Power & Protection**: Input power source(s) & voltage range (USB-C, barrel
  jack, LiPo, screw terminal), required voltage rails + max continuous/peak
  current per rail, battery charging, ESD/reverse-polarity needs.
- **Interfaces & Components**: Preferred MCU/ICs, sensors, actuators, buses
  (USB, I2C, SPI, UART, CAN), logic voltage levels (3.3V vs 5V), debug/flashing
  header (SWD/JTAG/UART), user I/O (LEDs, buttons).
- **Budget & Manufacturing**: Target BOM ceiling, fab house & assembly method
  (JLCPCB SMT vs hand-soldered, minimum passive size 0402 vs 0603), target
  quantity, whether 3D STEP/glTF models are required for enclosure fit.
- **Signal Integrity & Environment**: High-speed/differential signals (USB D+/D-,
  Ethernet, RF, >20MHz SPI), noise-sensitive analog stages, ambient temperature
  or thermal dissipation constraints.
- **Bring-Up & Testability (DFT)**: Confirm whether compact size restricts probe
  pads or if dedicated test points (power rails, `GND`, key bring-up signals) and
  a bench bring-up guide should be included.

## Phase 2: Model ALL Requirements as Tests First

1. **Populate `specs/board.spec.json`** (validated by `specs/board-spec.schema.ts`):
   - Set `dimensions`, `mountingHoles`, `keepoutZones`, `fabRules`, `budget`,
     `powerRails`, `electrical` (`requireGroundNet: true`), `signalIntegrity`
     (`highSpeedNets`, `differentialPairs`, `maxDiffPairSkewMm`, `maxTraceLengthMm`),
     `requiredComponents`, `requiredNets`, and planned `simulations`.
2. **Write custom assertions in `tests/board.constraints.test.ts`**:
   - For every requirement that `specs/board.spec.json` does not cover directly
     (e.g., USB-C connector placed on the left edge, `5.1kΩ` pull-downs on CC1/CC2,
     ESD diode array connected to D+/D-, SWD header pins wired to MCU, LED
     current-limiting resistor values), add explicit `test(...)` cases inspecting
     `dist/circuit.json`.
3. **Verify the tests actually fail first**:
   ```bash
   just test
   ```
   Confirm the newly added requirements fail against the current blank/prior
   board. Do **not** proceed to Phase 3 until every new requirement is visibly
   enforced by a failing test.

## Phase 3: Launch Live Preview Early

As soon as the spec/tests are locked and the initial board dimensions/outline
are written in `src/boards/main.circuit.tsx`:

1. Start the live preview server in the background:
   ```bash
   just dev
   ```
   `tsci dev` watches project files and automatically hot-reloads Schematic, PCB,
   and 3D views at `http://localhost:3020` on every file write.
2. Open `http://localhost:3020` in your agent's browser tool (if available) or
   let the user know it is ready to view so they can watch every iteration live.

## Phase 4: Incremental Placement-First Design Until Every Check Passes

1. Build and wire **1 to 2 subcircuits at a time** (outline + connectors + mounting holes -> power stage -> core IC -> peripherals -> silkscreen/polish). Do not dump dozens of unverified components in one pass.
2. Put each functional block in `src/subcircuits/<Block>.tsx` inside a `<group>` and compose them in `src/boards/main.circuit.tsx` with `autorouter="auto-local"` and `pcbStyle` / `RoutingTolerances` matching `specs/board.spec.json -> fabRules`.
3. Run `just check` (or `just test`) after each subcircuit and resolve all placement/courtyard overlaps before adding the next block. Use `just check-summary` to inspect the grouped error summary without reading raw `dist/checks-report.json`.
4. Run `just verify` before finishing. Never weaken tests or bypass DRC with `--ignore-*-drc` or `drcChecksDisabled`.

## Handling Feedback & Major Changes

Whenever the user asks to change requirements or add/swap/remove major sections:

1. Ask any clarifying questions about the change.
2. Update `specs/board.spec.json` and `tests/board.constraints.test.ts` FIRST,
   and run `just test` to confirm the updated requirements fail.
3. Add, edit, or delete the corresponding subcircuit(s) in `src/subcircuits/`
   until `just verify` passes cleanly.
