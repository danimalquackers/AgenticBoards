# AgenticBoards — PCB-TDD Workspace Rules

Design manufacturable, electrically verified PCBs using **tscircuit**, **ngspice**,
**KiCad CLI**, and **Freerouting**.

## Core Rules

1. **TDD First (`pcb-tdd` skill)**:
   - Update `specs/board.spec.json` and `tests/board.constraints.test.ts` **before**
     editing `src/boards/main.circuit.tsx` or `src/subcircuits/`.
   - Run `npm test` to see failing constraints, then implement modular subcircuits
     until all checks pass. Never bypass DRC with `--ignore-*-drc` or `drcChecksDisabled`.
   - On major user feedback (adding/swapping/removing sections), update spec & tests FIRST.

2. **Real Parts, Engineering Rigor & Simulation (`pcb-engineering` skill)**:
   - Use real in-stock parts with verified pinouts, footprints/3D models (`tsci search`,
     `tsci import`, `tsci convert`), and prices recorded in `specs/board.spec.json -> budget.bomCosts`.
   - Enforce power conditioning, decoupling, continuous ground planes (4L for high-speed),
     and IPC-2221 thermal/ampacity margins.
   - Prove critical analog/power behavior with SPICE simulations in `src/simulations/`.

3. **Live Visual Preview & Release (`pcb-release` skill)**:
   - Start `npm run dev` (`IsDaemon: true`) and open `http://localhost:3020` in the
     integrated browser (`browser_navigate`) so the user can inspect Schematics, PCB, and 3D live.
   - Run `npm run verify` and `npm run export` before declaring a board build-ready
     (use `npm run route` for external Freerouting if needed).
