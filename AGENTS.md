# AgenticBoards — PCB-TDD Workspace Rules

Design 100% fabrication- and assembly-ready PCBs using **tscircuit**, **ngspice**,
**KiCad CLI**, and **Freerouting**.

## Core Rules

1. **TDD First (`pcb-tdd` skill)**:
   - Update `specs/board.spec.json` and `tests/board.constraints.test.ts` **before**
     editing `src/boards/main.circuit.tsx` or `src/subcircuits/`.
   - Run `npm test` to observe failing constraints, then implement modular subcircuits
     until green. Never suppress DRC with `--ignore-*-drc` or `drcChecksDisabled`.
   - On major feedback (adding/swapping/removing sections), update spec & tests FIRST.

2. **100% Fab-Ready Engineering & SPICE Proof (`pcb-engineering` skill)**:
   - Use real in-stock parts with verified pinouts, footprints/3D models (`tsci search`,
     `tsci import`, `tsci convert`), and BOM pricing + LCSC/MPN in `specs/board.spec.json`.
   - Include all production support circuitry: reverse-polarity/ESD protection, USB-C
     `5.1kΩ` CC1/CC2 pull-downs, bulk + per-IC `100nF` decoupling, pull-ups, crystal
     load caps, debug header + power/GND test points, silkscreen labels/polarity marks,
     4-layer GND planes for high-speed signals, and IPC-2221 thermal/ampacity margins.
   - Prove critical power/analog behavior via `ngspice` simulations in `src/simulations/`.

3. **Live Visual Preview & Manufacturing Sign-Off (`pcb-release` skill)**:
   - Run `npm run dev` (`IsDaemon: true`) and open `http://localhost:3020` in the
     integrated browser (`browser_navigate`) for live Schematic, PCB, and 3D inspection.
   - A board is only done after `npm run verify` AND `npm run export` both pass with
     zero verification errors and zero `kicad-cli` DRC errors/unconnected nets.
