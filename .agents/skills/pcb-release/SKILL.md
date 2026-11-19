---
name: pcb-release
description: >-
  Verify, autoroute (internal or external Freerouting), and export manufacturable
  deliverables: SVG renders, Gerbers, KiCad project, STEP/glTF 3D models, BOM CSV,
  and independent KiCad CLI DRC cross-checks.
---

# Verification, External Autorouting & Manufacturing Export

## 1. Final Verification Gate
Run:
```bash
npm run verify
```
Confirm zero TypeScript, Biome lint, DRC, mechanical, fab, BOM budget, electrical,
or SPICE simulation errors.

## 2. Optional External Autorouting (Freerouting)
If tscircuit's built-in `autorouter="auto-local"` cannot cleanly route a dense
multi-layer board, run:
```bash
npm run route
```
This exports Specctra DSN (`dist/routing/board.dsn`) and invokes headless
`freerouting` to generate `dist/routing/board.ses` (importable into KiCad on
`dist/exports/board.kicad_pcb`).

## 3. Export All Manufacturing & Visual Deliverables
Run:
```bash
npm run export
```
Outputs to `dist/exports/`:
- **Renders**: `schematic.svg`, `pcb.svg`, `assembly.svg`
- **Fabrication**: `gerbers.zip` (Gerbers + Excellon drills), `bom.csv`
- **KiCad**: `kicad-project.zip`, `board.kicad_pcb`, `board.kicad_sch`
- **3D CAD**: `board.step`, `board.gltf`
- **Netlist / DSN**: `netlist.txt`, `board.dsn`
- **Independent DRC**: `kicad-drc.json` (run via `kicad-cli pcb drc`)

Review `dist/exports/kicad-drc.json` for any clearance or copper issues, optionally
run `tsci quote` for fab pricing, and open `http://localhost:3020` in the integrated
browser (`npm run dev`) for final visual sign-off with the user.
