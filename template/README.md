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

| Command               | Purpose                                                                       |
| :-------------------- | :---------------------------------------------------------------------------- |
| `just dev`            | Start live tscircuit Schematic / PCB / 3D UI (`http://localhost:3020`)        |
| `just test`           | Run TDD constraints, DRC, electrical/SI/PI/thermal & SPICE tests              |
| `just check`          | Run checks & print grouped summary scorecard (`dist/checks-report.json`)      |
| `just check-summary`  | Print grouped summary from existing `dist/checks-report.json`                 |
| `just search <q...>`  | Search LCSC/JLCPCB parts concurrently                                         |
| `just fmt`            | Format & auto-fix all file types (`treefmt` / `nix fmt`, or `biome` fallback) |
| `just lint`           | Check formatting & lint rules across all files without modifying them         |
| `just verify`         | Full gate: `tsc --noEmit` + `just lint` + `just test`                         |
| `just doctor`         | Check toolchain binaries on `PATH`                                            |
| `just export-renders` | Export `schematic.svg`, `pcb.svg`, `assembly.svg`                             |
| `just export-gerbers` | Export `gerbers.zip` (Gerbers + Excellon drills)                              |
| `just export-pcba`    | Export JLCPCB `bom.csv` & Pick-and-Place CPL `pnp.csv`                        |
| `just export-kicad`   | Export `kicad-project.zip`, `board.kicad_pcb`, `board.kicad_sch`              |
| `just export-3d`      | Export `board.step` & `board.gltf`                                            |
| `just kicad-drc`      | Independent `kicad-cli pcb drc` error & unconnected-net gate                  |
| `just route`          | Export Specctra DSN & run headless `freerouting` → `dist/routing/board.ses`   |
| `just export-all`     | Run `verify`, all per-format exports, and `kicad-drc` for release             |

## Layout

- `specs/board.spec.json` & `specs/board-spec.schema.ts` — Declarative TDD PCB contract
- `src/boards/main.circuit.tsx` — Top-level board entrypoint (`src/subcircuits/`, `src/components/`, `src/simulations/`)
- `checks/` & `tests/` — Automated DRC, edge clearance, unrouted trace, BOM budget, IPC-2221 ampacity, diff-pair skew, and SPICE suites
- `scripts/export-pcba.ts` — JLCPCB BOM & Pick-and-Place CPL exporter
- `treefmt.nix` & `biome.json` — Polyglot formatting & strict linting rules (`.ts`/`.tsx`/`.js`/`.json`/`.md`/`.nix`/`.sh`/`justfile`)
- `.agents/` — Agent-agnostic skills (`pcb-tdd`, `pcb-engineering`, `pcb-release`) & Stop verification hook
