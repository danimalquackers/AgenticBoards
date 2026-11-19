---
name: pcb-tdd
description: >-
  TDD PCB design workflow: capture constraints in `specs/board.spec.json` and
  tests first, implement modular tscircuit subcircuits, iterate with `npm test`,
  and open the live tscircuit Schematic/PCB/3D UI in the integrated browser.
---

# PCB-TDD Design & Live UI Workflow

Always encode board requirements as executable tests **before** editing circuits
so constraints are never dropped during layout or large refactors.

## 1. Spec & Tests First (Red)
1. Clarify missing hard constraints: dimensions, layers (2 vs 4), mounting holes,
   keepouts, BOM budget, power rails/currents, interfaces, and high-speed nets.
2. Update `specs/board.spec.json` (schema: `specs/board-spec.schema.ts`), enabling
   `electrical.requireGroundNet: true` once rails are defined.
3. Add project-specific assertions to `tests/board.constraints.test.ts`.
4. Run `npm test` and confirm the new constraints fail (Red).

## 2. Modular Design & Iteration (Green)
1. Put each functional block in `src/subcircuits/<Block>.tsx` inside a `<group>`
   and connect blocks via named nets (`net.V5`, `net.V3V3`, `net.GND`, etc.).
2. Compose blocks in `src/boards/main.circuit.tsx` with `autorouter="auto-local"`.
3. Run `npm test` after edits until all DRC, spec, budget, and electrical checks pass.
   Never bypass checks with `--ignore-*-drc` or `drcChecksDisabled`.

## 3. Live tscircuit UI in Integrated Browser
To inspect the live Schematic, PCB layout, 3D model, and BOM interactively:
1. Start the dev server in the background (`IsDaemon: true`):
   ```bash
   npm run dev
   ```
   This serves tscircuit's interactive UI at `http://localhost:3020` with live reload.
2. Open it directly in Antigravity's integrated browser via `browser_navigate` to
   `http://localhost:3020`.

## 4. Incorporating Major Feedback
When asked to add, swap, or remove large sections of the board:
1. Update `specs/board.spec.json` and `tests/board.constraints.test.ts` FIRST.
2. Add, edit, or delete the corresponding subcircuit file(s) in `src/subcircuits/`.
3. Re-run `npm run verify` and refresh `http://localhost:3020`.
