---
name: pcb-release
description: >-
  Manufacturing export and release sign-off workflow. Use when `just verify`
  passes and you need external Freerouting, KiCad DRC, zone-filled Gerbers,
  JLCPCB BOM/PnP, 3D models, bring-up docs, or final release packaging.
---

# Manufacturing Release & Sign-Off

## 1. Optional External Autorouting & Length Tuning

When `autorouter="auto-local"` cannot route a dense board cleanly or differential pairs exceed `maxDiffPairSkewMm`:

```bash
just route       # stages sanitized DSN (fabRules, keepouts, netClasses, 45° snap) -> src/routing/board-routes.json
just route-tune  # optional: inserts 45° trombone meanders for differentialPairs
```

Consume `src/routing/board-routes.json` via `<autoroutingphase pcbTracePaths={boardRoutes} />` (see `pcb-engineering/references/tscircuit-reference.md`).

## 2. Targeted Per-Format Exports

Run `just --list` for all recipes. Common targeted exports during iteration:

- `just check-preview` — fast `dist/preview/schematic.svg` & `pcb.svg`
- `just check-kicad` — `kicad-cli pcb drc --refill-zones --save-board` + zone-filled `kicad-project.zip`
- `just export-gerbers` — `gerbers.zip` plotted from the KiCad-DRC-verified, zone-filled PCB
- `just export-pcba` — JLCPCB `bom.csv` + `pnp.csv`
- `just export-renders` / `just export-3d` / `just export-docs`

## 3. Full Release Pass

```bash
just export-all
```

Runs `just verify` -> `just check-kicad` (zero DRC errors, zero unconnected nets, refills zones, saves filled `kicad-project.zip`) -> zone-filled `gerbers.zip` -> PCBA -> renders -> 3D -> DSN/netlist -> `bringup-test-guide.md`.

Inspect `just check-status` and `dist/exports/kicad-drc.json` for any warnings, visually inspect `dist/exports/schematic.svg` and `pcb.svg` (and `http://localhost:3020`) for schematic clarity, silkscreen legibility, polarity marks, and connector orientation.

## 4. Final Independent Sign-Off (`pcb-review`)

Run a **Stage 2 `pcb-review`** audit before presenting the board to the user. Fix every blocking defect reported and re-run `just export-all` until clean.

**Done when**: `just export-all` exits 0 and Stage 2 `pcb-review` returns `PASS` (or `PASS WITH MINOR NOTES` with zero critical defects).
