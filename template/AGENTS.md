# AgenticBoards — PCB-TDD Workspace Rules

Design fabrication- and assembly-ready PCBs using **tscircuit**, **ngspice**,
**KiCad CLI**, and **Freerouting**.

All developer and agent workflows run through **`just`** (`just --list`).

## Non-Negotiable Rules

1. **Requirements Discovery & TDD (`pcb-tdd` skill)**:
   - **Do NOT write or edit any file in `src/`** until all three steps below are complete:
     1. **Ask clarifying questions**: Audit every unspecified hard constraint and ask the user
        before assuming (dimensions/enclosure, layer count, mounting holes, keepouts, input
        power & rails/currents, interfaces/MCU/logic levels, BOM budget, SMT vs hand-solder,
        thermal/SI/analog sensitivity).
     2. **Model every requirement as executable tests**: Encode all constraints in
        `specs/board.spec.json` and add explicit test cases to `tests/board.constraints.test.ts`
        (and SPICE assertions for power/analog stages) for every requirement not covered by the
        JSON schema alone (e.g., connector edge placement, USB-C `5.1kΩ` CC pull-downs, ESD
        protection, debug headers, pin-to-pin connectivity).
     3. **Confirm the new tests fail first**: Run `just test` and verify the newly modeled
        requirements fail against the current board—proving the test suite will catch regressions
        before you begin designing.
   - Repeat this exact process whenever the user requests architectural changes or adds/removes
     subsystems. Never suppress or weaken DRC/test checks (`--ignore-*-drc`, `drcChecksDisabled`).

2. **Start Live Preview**:
   - Once the spec and failing tests are in place and the initial board outline is set, start
     `just dev` in the background and open `http://localhost:3020` (in your sidecar browser if
     available, or provide the link to the user to open it). Keep it running so `tsci dev`'s built-in file
     watcher live-updates Schematic, PCB, and 3D views on every file write.

3. **Build Incrementally**:
   - Add and verify **1 to 2 subcircuits at a time** (`just check` / `just check-summary`) and
     resolve placement/courtyard overlaps before wiring the next block.

4. **Fab-Ready Engineering (`pcb-engineering` skill)**:
   - Use real, in-stock parts with verified pinouts, footprints/3D models (`just search`,
     `tsci import`, `tsci convert`), and BOM pricing + LCSC/MPN in `specs/board.spec.json`.
   - Consult `.agents/skills/pcb-engineering/references/tscircuit-reference.md` for `<board>`
     via/tolerance props, semantic primitives (`<connector>`, `<testpoint>`, `<hole>`), and
     routing patterns instead of reading `node_modules`.
   - Include all production support circuitry: reverse-polarity/ESD protection, USB-C `5.1kΩ`
     CC1/CC2 pull-downs, bulk + per-IC `100nF` decoupling, pull-ups, crystal load caps, debug
     header, moderate `<testpoint>` pads on `GND` and primary power rails (never on high-speed
     diff pairs or RF feeds), silkscreen labels/polarity marks, 4-layer GND planes for
     high-speed signals, and IPC-2221 thermal/ampacity margins.
   - Prove critical power and analog behavior with `ngspice` simulations in `src/simulations/`.

5. **Per-Format Exports, Docs & Manufacturing Sign-Off (`pcb-release` skill)**:
   - Use targeted `just` recipes during iteration (`just export-renders`, `just export-3d`,
     `just export-gerbers`, `just export-pcba`, `just export-kicad`, `just export-test-guide`,
     `just route`).
   - A board is only complete after `just export-all` (which runs `just verify`, all exports,
     `dist/exports/bringup-test-guide.md`, and `just kicad-drc`) passes with zero errors and
     zero unconnected nets, and you have visually verified the live preview at
     `http://localhost:3020`.
