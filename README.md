# AgenticBoards

A declarative Nix + TDD starter template for designing **fabrication- and
assembly-ready PCBs** with an AI coding agent in Antigravity.

Powered by **tscircuit**, **ngspice**, **KiCad CLI**, **Freerouting**, **Node.js 24**,
and **Biome**.

## Start a New Project

**Nix Flake Template:**
```bash
nix flake new my-board -t github:<owner>/AgenticBoards
cd my-board && git init && git add -A && direnv allow
```

**Or Git Clone / GitHub Template:**
```bash
git clone <repo-url> my-board && cd my-board && direnv allow
```

Entering the shell (`direnv allow`, `nix develop`, or `nix-shell`) provisions all
tools and builds/links `node_modules` declaratively from `package-lock.json`.
Open the folder in Antigravity and prompt the agent with your PCB goals, dimensions,
budget, power rails, and interfaces.

## Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start live tscircuit Schematic / PCB / 3D UI (`http://localhost:3020`) |
| `npm run verify` | Run typecheck, Biome lint, DRC, spec/budget/SI/PI/thermal checks & SPICE tests (`npm test` runs checks/tests only) |
| `npm run export` | Export Gerbers, JLCPCB BOM & PnP CSV, KiCad project, STEP/glTF 3D, SVGs + `kicad-cli` DRC gate |
| `npm run route` | Optional external Freerouting (`Specctra DSN -> SES`) for dense boards |

> **Updating npm dependencies**: `rm -f node_modules && npm install --package-lock-only --legacy-peer-deps`, stage `package.json` + `package-lock.json`, and run `direnv reload`.

## Structure

- `shell.nix`, `flake.nix`, `.envrc` — Declarative Nix toolchain & flake template
- `specs/board.spec.json` & `specs/board-spec.schema.ts` — TDD PCB specification contract (written first)
- `src/boards/main.circuit.tsx` — Board entrypoint (`src/subcircuits/`, `src/components/`, `src/simulations/`)
- `checks/` & `tests/` — Automated DRC, edge clearance, unrouted trace, BOM budget, IPC-2221 ampacity, diff-pair skew, and SPICE verification
- `scripts/` — Full manufacturing/PCBA export pipeline (`export-all.ts`) & Freerouting wrapper (`freeroute.ts`)
- `.agents/` — Workspace skills (`pcb-tdd`, `pcb-engineering`, `pcb-release`) & TDD Stop guard hook
