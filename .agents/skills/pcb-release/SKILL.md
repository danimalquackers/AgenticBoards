---
name: pcb-release
description: >-
  Final fab-readiness sign-off: run full verification, optional external
  Freerouting, and export Gerbers, JLCPCB BOM + Pick-and-Place CPL, KiCad
  project, STEP/glTF 3D models, SVG renders, and independent KiCad CLI DRC.
---

# Fab-Ready Verification & Manufacturing Export

## 1. Full Verification Gate
```bash
npm run verify
```
Must pass with zero TypeScript, Biome, DRC, unrouted-trace, edge-clearance,
mechanical, fab, BOM-budget, IPC-2221 ampacity, diff-pair skew, or SPICE errors.

## 2. Optional External Autorouting
For dense multi-layer boards where `autorouter="auto-local"` cannot route cleanly:
```bash
npm run route
```
Exports `dist/routing/board.dsn` and runs headless `freerouting` -> `dist/routing/board.ses`.

## 3. Manufacturing & PCBA Export + Independent KiCad DRC
```bash
npm run export
```
Generates `dist/exports/` and exits non-zero if internal verification OR
`kicad-cli pcb drc` finds any error or unconnected net:
- **Fabrication & PCBA**: `gerbers.zip`, `bom.csv` (JLCPCB-formatted), `pnp.csv` (Pick-and-Place CPL)
- **KiCad**: `kicad-project.zip`, `board.kicad_pcb`, `board.kicad_sch`, `kicad-drc.json`
- **3D & Renders**: `board.step`, `board.gltf`, `schematic.svg`, `pcb.svg`, `assembly.svg`
- **Netlist / Routing**: `netlist.txt`, `board.dsn`

Inspect `dist/exports/kicad-drc.json` for any remaining warnings, optionally run
`tsci quote` for fab pricing, and open `http://localhost:3020` (`npm run dev`) in
the integrated browser for final visual sign-off (silkscreen legibility, polarity
marks, connector alignment, 3D clearances).
