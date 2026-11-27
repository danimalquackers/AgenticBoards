---
name: pcb-tdd
description: >-
  Test-Driven Hardware Development workflow. Use when starting a new PCB,
  gathering requirements, modifying specs/constraints, or iterating on
  subcircuit placement and routing. Do not use for final manufacturing exports
  (`pcb-release`) or read-only audits (`pcb-review`).
---

# Test-Driven PCB Design Workflow

Treat every hardware requirement as an executable test written **before** circuit code.

## Phase 1: Requirements Discovery

Audit the user's request and ask concise clarifying questions for any unspecified hard constraint:

- **Mechanical**: Exact or max `width × height` (mm), layer count (2 vs 4+), Z-height limits (`maxTopHeightMm`/`maxBottomHeightMm`), mounting holes, connector edges, keepout zones.
- **Power**: Input sources & voltage ranges, output rails + max continuous/peak current, battery charging, ESD/reverse-polarity protection.
- **Interfaces**: MCU/ICs, sensors, actuators, buses (USB, I2C, SPI, UART, CAN), logic levels, debug header (SWD/UART), user I/O.
- **Manufacturing & Budget**: Max BOM/unit cost, fab house & assembly (SMT vs hand-solder, min passive size), target quantity, 3D STEP/glTF needs.
- **SI / Environment / DFT**: High-speed/diff-pair/RF nets, sensitive analog stages, thermal limits, test-point accessibility.

**Done when**: Every hard constraint above is either specified by the user or explicitly deferred.

## Phase 2: Lock Requirements into Red Tests

1. **Populate `specs/board.spec.json`** (validated by `specs/board-spec.schema.ts`):
   - Set `dimensions` (including `stackup` if impedance-controlled), `mountingHoles`, `keepoutZones`, `netClasses`, `fabRules`, `budget`, `powerRails`, `electrical` (flip `requireGroundNet` to `true`), `signalIntegrity` (`highSpeedNets`, `differentialPairs`, `maxDiffPairSkewMm`, `maxTraceLengthMm`, `buses`), `requiredComponents`, `requiredNets`, and planned `simulations`.
2. **Add custom assertions in `tests/board.constraints.test.ts`**:
   - Encode requirements not covered by the JSON schema (connector edge placement, specific pull-ups/pull-downs, ESD routing, debug header wiring, resistor/capacitor values) by asserting against `dist/circuit.json`.
3. **Confirm tests fail first**:
   ```bash
   just test
   ```

**Done when**: Every new requirement fails visibly against the current board.

## Phase 3: Start Live Preview

Once the initial board outline exists in `src/boards/main.circuit.tsx`, start the hot-reloading viewer in the background:

```bash
just dev
```

Open `http://localhost:3020` (if a browser tool is available) or share the URL with the user.

## Phase 4: Incremental Build & Placement

1. **Pre-Routing Review**: Verify active ICs, connectors, and protection parts have real LCSC/MPN SKUs, verified pinouts, and `heightMm` in `specs/board.spec.json -> budget.bomCosts` (`just parts-verify`). Run `just check-placement` (~1–2s) and `just check-preview`. On complex or enclosure-constrained boards (> 10 parts, tight Z-height, RF, high-speed, or switching power), run a **Stage 1 `pcb-review`** before routing.
2. **Build 1–2 subcircuits at a time** (outline + connectors + holes -> power -> core IC -> peripherals -> silkscreen). Place each functional block in `src/subcircuits/<Block>.tsx` inside a `<group>` and compose them in `src/boards/main.circuit.tsx` with `autorouter="auto-local"`, `pcbStyle`, and `<board>` clearance/via props matching `fabRules` (see `pcb-engineering/references/tscircuit-reference.md`).
3. **Verify each increment**: Run `just check-placement` while iterating on placement/courtyards/schematic layout, then `just check` and `just check-status` (or `just check-summary`) to inspect grouped findings without reading raw JSON.
4. **Avoid micro-nudging, hang loops & ad-hoc routers**: If `auto-local` times out after a keepout or `pcbPath` edit, revert the blocking change rather than retrying small tweaks. If DRC still fails after 3–5 placement fixes, re-architect the crowded zone or run `just route` / `just route-tune`. If routing still fails, stop and ask the user.
5. **Run `just verify`**: Confirm TypeScript, lint, unit tests, board constraints, and SPICE simulations all pass with zero suppressed checks.

**Done when**: `just verify` exits 0. **Next step**: Follow `pcb-release` (`just export-all`) and Stage 2 `pcb-review`.

## Handling Requirement Changes

When the user changes requirements or adds/swaps/removes subsystems:

1. Clarify ambiguities.
2. Update `specs/board.spec.json` and `tests/board.constraints.test.ts` and confirm `just test` goes red.
3. Update `src/subcircuits/` until `just verify` is green.
