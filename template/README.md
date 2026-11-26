# **PROJECT_NAME**

Fabrication- and assembly-ready PCB project scaffolded with **AgenticBoards**
(`tscircuit`, `ngspice`, `KiCad CLI`, `Freerouting`, `treefmt-nix`).

## Setup

**With Nix (recommended):**

```bash
direnv allow                   # or `nix develop` / `nix-shell`
npm install --legacy-peer-deps # if not already installed by scaffolder
just doctor                    # confirm all tools are available
just verify
```

**Without Nix:**

Ensure Node.js 22.12+ and `just` are installed (plus `ngspice`, `kicad-cli`,
`freerouting`, `biome`, and optionally `treefmt` for full simulation, DRC,
routing, and formatting), then run:

```bash
npm install --legacy-peer-deps
just doctor
just verify
```

## Working With Your AI Coding Agent

Open this folder in your AI coding agent and describe your PCB goals and
constraints (dimensions, layers, mounting holes, budget, power rails,
interfaces).

- **Requirements & Tests First**: Your agent asks clarifying questions first,
  encodes every requirement in `specs/board.spec.json` and
  `tests/board.constraints.test.ts`, and runs `just test` to confirm the new
  constraints fail before designing any circuits.
- **Live Preview**: `just dev` serves live Schematic, PCB, and 3D views at
  `http://localhost:3020` and hot-reloads on every file write.
- **Modular Subcircuits**: Keep major functional blocks in `src/subcircuits/`
  and compose them in `src/boards/main.circuit.tsx` so large sections can be
  added, swapped, or removed cleanly.

## Commands (`just --list`)

All project commands run through **`just`** (`package.json` holds metadata and
dependencies only):

| Stage    | Command                  | Purpose                                                                                        |
| :------- | :----------------------- | :--------------------------------------------------------------------------------------------- |
| `setup`  | `just doctor`            | Check toolchain binaries on `PATH`                                                             |
| `setup`  | `just parts-search <q>`  | Search LCSC/JLCPCB parts concurrently                                                          |
| `dev`    | `just dev`               | Start live tscircuit Schematic / PCB / 3D UI (`http://localhost:3020`)                         |
| `dev`    | `just fmt` / `just lint` | Format or lint all file types (`treefmt` / `nix fmt`, or `biome` fallback)                     |
| `check`  | `just check-placement`   | Fast placement, courtyard, keepout, Z-height, BOM & schematic check (no autorouting)           |
| `check`  | `just check`             | Full board check & grouped scorecard (`dist/checks-report.json`)                               |
| `check`  | `just check-summary`     | Print grouped summary from existing `dist/checks-report.json`                                  |
| `check`  | `just check-kicad`       | Independent `kicad-cli pcb drc` gate (syncs `fabRules`, refills zones, saves filled board)     |
| `check`  | `just test` / `verify`   | Run TDD constraints + cached SPICE tests (`verify` adds `tsc --noEmit` + `just lint`)          |
| `route`  | `just route`             | Run headless `freerouting` (45° snap, keepouts, rail widths) → `src/routing/board-routes.json` |
| `route`  | `just route-tune`        | Length-match differential pairs in `src/routing/board-routes.json`                             |
| `export` | `just export-kicad`      | Export `board.kicad_pcb`, `board.kicad_sch`, `board.kicad_pro`, and `kicad-project.zip`        |
| `export` | `just export-gerbers`    | Export `gerbers.zip` from the KiCad-DRC-verified, zone-filled `board.kicad_pcb`                |
| `export` | `just export-pcba`       | Export JLCPCB `bom.csv` & Pick-and-Place CPL `pnp.csv`                                         |
| `export` | `just export-renders`    | Export `schematic.svg`, `pcb.svg`, `assembly.svg`                                              |
| `export` | `just export-3d`         | Export `board.step` & `board.gltf`                                                             |
| `export` | `just export-docs`       | Export `bringup-test-guide.md` (continuity, diode, resistance, voltage & SI checks)            |
| `export` | `just export-all`        | Full release pipeline: `verify` → `check-kicad` → zone-filled Gerbers → all exports & docs     |

## Layout

- `specs/board.spec.json` & `specs/board-spec.schema.ts` — Declarative TDD PCB contract
- `src/boards/main.circuit.tsx` — Top-level board entrypoint (`src/subcircuits/`, `src/components/`, `src/simulations/`)
- `checks/` & `tests/` — Automated DRC, edge clearance, unrouted trace, BOM budget, IPC-2221 ampacity, diff-pair skew, and SPICE suites
- `scripts/export-pcba.ts` — JLCPCB BOM & Pick-and-Place CPL exporter
- `treefmt.nix` & `biome.json` — Polyglot formatting & strict linting rules (`.ts`/`.tsx`/`.js`/`.json`/`.md`/`.nix`/`.sh`/`justfile`)
- `.agents/` — Agent-agnostic skills (`pcb-tdd`, `pcb-engineering`, `pcb-release`, `pcb-review`) & Stop verification hook
