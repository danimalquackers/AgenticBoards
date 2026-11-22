---
name: pcb-release
description: >-
  Final fab-readiness sign-off using `just`: run verification, optional external
  Freerouting, per-format exports (renders, Gerbers, JLCPCB BOM + PnP, KiCad,
  STEP/glTF 3D), and independent KiCad CLI DRC cross-checks.
---

# Fab-Ready Verification & Per-Format Exports

## 1. Targeted Exports During Iteration

Generate only what you need via `just` (run `just` to list all recipes):

- `just export-renders` — `schematic.svg`, `pcb.svg`, `assembly.svg`
- `just export-gerbers` — `gerbers.zip` (Gerbers + Excellon drills)
- `just export-pcba` — JLCPCB `bom.csv` + Pick-and-Place CPL `pnp.csv`
- `just export-kicad` — `kicad-project.zip`, `board.kicad_pcb`, `board.kicad_sch`
- `just export-3d` — `board.step`, `board.gltf`
- `just export-dsn` / `just export-netlist` — `board.dsn`, `netlist.txt`

## 2. Optional External Autorouting (Freerouting)

For dense multi-layer boards where `autorouter="auto-local"` cannot route cleanly:

```bash
just route
```

Exports `dist/exports/board.dsn` and runs headless `freerouting` → `dist/routing/board.ses`.

## 3. Full Release Sign-Off Gate

```bash
just export-all
```

Runs `just verify` (TypeScript, Biome, DRC, unrouted-trace, edge-clearance,
mechanical, fab, BOM-budget, IPC-2221 ampacity, diff-pair skew, SPICE tests),
generates all deliverables in `dist/exports/`, and executes `just kicad-drc`
(exiting non-zero if `kicad-cli pcb drc` reports any error or unconnected net).

Inspect `dist/exports/kicad-drc.json` for any remaining warnings, optionally run
`tsci quote` for fab pricing, and do a final visual sign-off in the live preview
at `http://localhost:3020` (`just dev`) in your browser if possible for silkscreen legibility,
polarity marks, connector alignment, and 3D clearances.
