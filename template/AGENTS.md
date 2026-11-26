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
   - Add and verify **1 to 2 subcircuits at a time** (`just check-placement` for fast ~1–2s
     placement/courtyard/keepout/Z-height checks, `just check-preview` for quick visual
     SVGs, then `just check` / `just check-summary` / `just check-status`).

4. **Fab-Ready Engineering (`pcb-engineering` skill)**:
   - Use real, in-stock parts with verified pinouts, footprints/3D models (`just parts-search`,
     `just parts-verify`, `tsci import`, `tsci convert`), and BOM pricing + LCSC/MPN +
     `heightMm` in `specs/board.spec.json`.
   - Load the matching domain reference pack under `.agents/skills/pcb-engineering/references/`
     (`tscircuit-reference.md`, `power-electronics.md`, `high-speed-interfaces.md`,
     `rf-wireless.md`, `analog-mixed-signal.md`, `high-voltage-isolation.md`) instead of
     reading `node_modules`.
   - Include all production support circuitry: reverse-polarity/ESD protection, USB-C `5.1kΩ`
     CC1/CC2 pull-downs, bulk + per-IC `100nF` decoupling, pull-ups, crystal load caps, debug
     header, moderate `<testpoint>` pads on `GND` and primary power rails (never on high-speed
     diff pairs or RF feeds), silkscreen labels/polarity marks, 4-layer GND planes for
     high-speed signals, and IPC-2221 thermal/ampacity margins.
   - Prove critical power and analog behavior with `ngspice` simulations in `src/simulations/`.

5. **Per-Format Exports, Docs & Independent Verification (`pcb-release` & `pcb-review` skills)**:
   - Use targeted `just` recipes during iteration (`just export-renders`, `just export-3d`,
     `just export-gerbers`, `just export-pcba`, `just export-kicad`, `just export-docs`,
     `just route`, `just route-tune`).
   - Run `just export-all` (which runs `just verify`, `just check-kicad`, zone-filled Gerbers,
     and all deliverables) until it passes with zero errors and zero unconnected nets.
   - Launch an **independent verifier subagent** (`pcb-review`) at Stage 1 (pre-routing BOM,
     Z-height & architecture gate on complex boards) and Stage 2 (final fab sign-off), and
     visually verify the live preview at `http://localhost:3020`.
