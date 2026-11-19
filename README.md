# AgenticBoards

A declarative **Nix + TDD-for-PCBs** template for designing, simulating, and
exporting circuit boards with an AI coding agent in **Antigravity**.

Built on **Nix (`shell.nix` / `flake.nix`)**, **Node.js 22**, **tscircuit**,
**ngspice**, **KiCad CLI**, **Freerouting**, and **Biome** — no Bun and no manual
`npm install` required.

## Start a New Electronics Project

### Option A: Nix Flake Template

```bash
nix flake new my-board -t github:<owner>/AgenticBoards
cd my-board
git init && git add -A
direnv allow      # or `nix develop` / `nix-shell`
```

### Option B: Git Clone / GitHub Template
```bash
git clone <your-repo-url> my-board
cd my-board
direnv allow      # or `nix develop` / `nix-shell`
```

`shell.nix` uses `importNpmLock` to build `node_modules` declaratively into
`/nix/store` from `package-lock.json` and symlink it automatically alongside
`ngspice`, `kicad-cli`, `freerouting`, and `biome`.

Open the folder in Antigravity and prompt the agent with your PCB goals and
constraints (dimensions, budget, power rails, interfaces, layer count).

## Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start live tscircuit Schematic / PCB / 3D UI (`http://localhost:3020`) |
| `npm run verify` | Run typecheck, lint, DRC, spec constraints, SI/PI/thermal & SPICE tests (`npm test` runs checks/tests only) |
| `npm run export` | Export SVG renders, Gerbers, KiCad project, STEP/glTF 3D models, BOM CSV + `kicad-cli` DRC |
| `npm run route` | Optional external Freerouting (`Specctra DSN -> SES`) for dense boards |

> **Adding npm packages declaratively**: Run `npm install --package-lock-only <pkg>`,
> commit/stage `package.json` + `package-lock.json`, and run `direnv reload`.

## Layout

- `shell.nix`, `flake.nix`, `.envrc` — Single-source declarative Nix toolchain + flake template
- `specs/board.spec.json` & `specs/board-spec.schema.ts` — Declarative TDD PCB contract (written first)
- `src/boards/main.circuit.tsx` — Blank top-level board entrypoint
- `src/subcircuits/`, `src/components/`, `src/simulations/` — Modular blocks, imported footprints/3D models, SPICE testbenches
- `checks/` & `tests/` — Built-in DRC, mechanical/fab/budget constraints, IPC-2221/SI/PI heuristics, and Node test suites
- `.agents/skills/` & `.agents/hooks.json` — Direct skills (`pcb-tdd`, `pcb-engineering`, `pcb-release`) and Stop verification guard
