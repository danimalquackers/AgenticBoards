# AgenticBoards (`create-agentic-board`)

Scaffold **fabrication- and assembly-ready PCB projects** designed with AI
coding agents using a **test-driven hardware workflow (TDD)** powered by
**tscircuit**, **ngspice**, **KiCad CLI**, **Freerouting**, **treefmt-nix**,
and **just**.

Works declaratively with **Nix** (`nix run` / `nix flake new` / `shell.nix`) and
independently without Nix (`npx create-agentic-board`), and follows the open
`AGENTS.md` + `.agents/skills/` conventions so it works with any AI coding
agent.

---

## Quick Start

### With Nix (Recommended — Zero Manual Tool Installs)

```bash
nix run github:danimalquackers/AgenticBoards -- my-board
cd my-board
direnv allow      # or `nix develop` / `nix-shell`
just verify
```

_(You can also initialize via Nix flake templates: `nix flake new my-board -t github:danimalquackers/AgenticBoards`.)_

### Without Nix (macOS / Linux / Windows)

Requires **Node.js 22.12+** and **just**; install optional native tools
(`ngspice`, `kicad-cli`, `freerouting`, `biome`, `treefmt`) via your system
package manager (for example `brew install just ngspice biome`, plus KiCad for
`kicad-cli`):

```bash
npx create-agentic-board my-board --no-nix
cd my-board
just doctor       # check installed tools on PATH
just verify
```

---

## How the Test-Driven Workflow Works

Open your scaffolded project in your AI coding agent and describe the board you
want to build. The bundled rules (`AGENTS.md`), skills (`.agents/skills/`), and
Stop hook (`.agents/hooks.json`) enforce a strict test-driven hardware loop so
constraints are never silently dropped as designs evolve:

1. **Requirements Discovery & Clarifying Questions** — Before writing any
   circuit code, the agent audits your prompt for missing mechanical, electrical,
   power, interface, budget, and thermal constraints and asks clarifying
   questions instead of guessing.
2. **Model All Requirements as Failing Tests First** — Every constraint
   (dimensions, layers, mounting holes, keepouts, BOM budget, power rails,
   signal-integrity limits, SPICE assertions, and custom structural rules) is
   encoded into `specs/board.spec.json` and `tests/board.constraints.test.ts`.
   The agent runs `just test` first to confirm those new tests fail against the
   unimplemented board, verifying every constraint is actively enforced.
3. **Live Preview** — Once the spec and initial board outline are in
   place, the agent launches `just dev` (`http://localhost:3020`). `tsci dev`
   watches files and hot-reloads the Schematic, PCB, and 3D views on every save
   so you can watch the board evolve live in your browser.
4. **Incremental Fab-Ready Engineering & SPICE Proof** — Components are selected
   with real LCSC/MPN part numbers, verified pinouts, footprints, 3D models, and
   unit costs. Functional blocks live in `src/subcircuits/` (making large
   additions or removals clean), with full support circuitry (ESD/reverse-polarity
   protection, USB-C `5.1kΩ` CC pull-downs, decoupling, pull-ups, debug headers,
   test points, silkscreen markings) and `ngspice` simulations iterated until
   `just verify` passes with zero errors.
5. **Per-Format Exports & Independent KiCad DRC Sign-Off** — Generate only the
   outputs you need during iteration (`just export-renders`, `just export-3d`,
   `just export-gerbers`), or run `just export-all` for the full manufacturing
   bundle (Gerbers, JLCPCB BOM + Pick-and-Place CPL, KiCad project, STEP/glTF,
   SVGs).

---

## Example Prompts

- **Initial board design:**
  > "Design a 50×35 mm 4-layer USB-C powered RP2040 sensor board with 4× M3
  > mounting holes at the corners, a 3.3V 800mA buck regulator, BME280 I2C
  > sensor, SWD debug header, and ESD protection. Keep total unit BOM under \$12."
- **Major architectural feedback:**
  > "Remove the BME280 subcircuit, add a microSD card slot on SPI0, and shrink
  > the board height to 30 mm."
- **Manufacturing sign-off:**
  > "Run `just export-all` and confirm zero verification or KiCad DRC errors."

---

## Automated Checks Enforced by `just verify`

| Category                                 | Automated Rules                                                                                                                                                                                                                                              |
| :--------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Formatting & Linting (`treefmt-nix`)** | Opinionated Biome rules (`.ts`, `.tsx`, `.js`, `.mjs`, `.json`), Prettier (`.md`, `.yaml`), `nixfmt` (`.nix`), `just --fmt` (`justfile`), `shfmt` + `shellcheck` (`.sh`), plus `tsc --noEmit`                                                                |
| **DRC & Routing**                        | Native Circuit JSON errors, `@tscircuit/checks` (trace overlaps, clearances, via spacing, courtyard overlap, out-of-board parts/traces), zero unrouted airwires (`drc.unrouted_trace`)                                                                       |
| **Mechanical**                           | Max & exact board `width × height` with tolerance, layer count, mounting hole coordinates/diameters, keepout zone overlaps, optional 3D model coverage                                                                                                       |
| **Fab & PCBA**                           | Min trace width, min via drill & outer diameter, copper-to-board-edge clearance (`minEdgeClearanceMm`), footprint coverage, LCSC/MPN part numbers, silkscreen labels                                                                                         |
| **Budget**                               | Every placed component must be priced in `specs/board.spec.json -> budget.bomCosts`; fails if BOM or estimated total unit cost exceeds budget                                                                                                                |
| **Electrical / PI / SI / Thermal**       | Power-to-GND dead-short detection, rail decoupling caps & IC decoupling proximity, IPC-2221 trace ampacity for `maxCurrentA` / `maxTraceTempRiseC`, floating pins, max trace lengths, differential-pair skew (`maxDiffPairSkewMm`), 4-layer stackup advisory |
| **Simulation & Cross-DRC**               | `ngspice` analog simulation probe assertions (`avg`, `min`, `max`, `final`, `ripple`) + independent `kicad-cli pcb drc` error & unconnected-net gate                                                                                                         |

---

## Commands (`just --list`)

All project tasks are standardized through **`just`** (`package.json` holds
dependencies and metadata only):

| Command                                   | Purpose                                                                                  |
| :---------------------------------------- | :--------------------------------------------------------------------------------------- |
| `just dev`                                | Start live tscircuit Schematic / PCB / 3D UI (`http://localhost:3020`)                   |
| `just test`                               | Run TDD constraints, DRC, electrical/SI/PI/thermal & SPICE test suites                   |
| `just check`                              | Run checks and print a full verification scorecard (`dist/checks-report.json`)           |
| `just fmt`                                | Format & auto-fix all file types (`treefmt`, or `biome` fallback)                        |
| `just lint`                               | Check formatting & lint rules without modifying files (`nix flake check` also runs this) |
| `just verify`                             | Full verification gate (`tsc --noEmit` + `just lint` + `just test`)                      |
| `just doctor`                             | Check toolchain binaries on `PATH`                                                       |
| `just export-renders`                     | Export `schematic.svg`, `pcb.svg`, `assembly.svg`                                        |
| `just export-gerbers`                     | Export fabrication `gerbers.zip` (Gerbers + Excellon drills)                             |
| `just export-pcba`                        | Export JLCPCB `bom.csv` & Pick-and-Place CPL `pnp.csv`                                   |
| `just export-kicad`                       | Export `kicad-project.zip`, `board.kicad_pcb`, `board.kicad_sch`                         |
| `just export-3d`                          | Export 3D CAD models (`board.step`, `board.gltf`)                                        |
| `just export-dsn` / `just export-netlist` | Export Specctra `board.dsn` / human-readable `netlist.txt`                               |
| `just kicad-drc`                          | Run independent `kicad-cli pcb drc` gate on `board.kicad_pcb`                            |
| `just route`                              | Export Specctra DSN and run headless `freerouting` → `dist/routing/board.ses`            |
| `just export-all`                         | Run `verify`, all per-format exports, and `kicad-drc` for release sign-off               |

---

## Scaffolder CLI Options

Run `create-agentic-board --help` for full usage (powered by `commander`):

```text
create-agentic-board [project-dir] [options]
  --no-nix       Omit Nix and direnv files (flake.nix, shell.nix, treefmt.nix, .envrc)
  --no-git       Skip `git init && git add -A`
  --install      Force running `npm install --legacy-peer-deps`
  --no-install   Skip running `npm install` even when not using Nix
  -V, --version  Output the version number
  -h, --help     Display help
```

## Repository Structure

- `bin/create-agentic-board.mjs` — `commander`-based Node ESM scaffolder CLI
- `flake.nix`, `treefmt.nix`, `biome.json`, `justfile`, `package.json` — Exposes `apps.default` (`nix run`), `templates.default` (`nix flake new`), `devShells.default`, `formatter` (`nix fmt`), `checks.formatting`, and npm `bin` (`npx`)
- `template/` — Self-contained PCB project (`justfile`, `shell.nix`, `flake.nix`, `treefmt.nix`, `biome.json`, `specs/`, `src/`, `checks/`, `tests/`, `scripts/export-pcba.ts`, `.agents/`)
