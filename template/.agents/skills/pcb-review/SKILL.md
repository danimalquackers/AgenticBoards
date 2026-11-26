---
name: pcb-review
description: >-
  Read-only, unbiased hardware design verifier. Use at Stage 1 (pre-routing
  architecture/BOM/Z-height check on complex boards) and Stage 2 (final fab
  sign-off after `just export-all`). Reports defects only; never edits files.
---

# Independent Hardware Design Verifier (`pcb-review`)

Run inside a **fresh, read-only verifier subagent** (if your host environment cannot spawn subagents, run this checklist as a dedicated report-only self-review pass before making any further edits).

## Two Verification Checks

1. **Stage 1 — Pre-Routing Architecture, BOM & Mechanical Check (Fast)**
   - **When**: Required before routing on complex or enclosure-constrained boards (> 10 parts, tight Z-height, RF/antenna, high-speed USB/Ethernet, or switching power); optional on simple breakouts.
   - **Artifacts to pass**: Original user requirements, `specs/board.spec.json`, `tests/`, `src/`, `dist/preview/schematic.svg`, `dist/preview/pcb.svg`, and `just check-placement` output.
   - **Focus**: Real LCSC/MPN SKUs, datasheet pinouts/ratings, Z-height fit (`maxTopHeightMm`/`maxBottomHeightMm`), connector orientation/mechanicals, and protocol architecture.

2. **Stage 2 — Final Fab Sign-Off Check (Mandatory)**
   - **When**: After `just export-all` exits 0.
   - **Artifacts to pass**: Original user requirements, `specs/board.spec.json`, `tests/`, `src/`, `just check-status` output, `dist/exports/kicad-drc.json`, `dist/exports/bom.csv`, `dist/exports/schematic.svg`, `dist/exports/pcb.svg`, and `dist/exports/bringup-test-guide.md`.
   - **Focus**: Full electrical, DRC, BOM/PnP, visual clarity, and bring-up guide sign-off.

## Unbiased Handoff Rules

- Pass **only** the original user requirements (plus explicit user answers) and the artifact paths above.
- Omit the author's design rationale, excuses, or "known minor issues" framing.
- Report findings only — make zero file edits.

---

## Audit Checklist

### 1. Independent Research First

Verify external constraints independently before trusting `src/` or `specs/board.spec.json`:

- **Mechanical/enclosure specs** referenced in the prompt (dimensions, thickness, Z-height, connector protrusion, mounting holes).
- **Protocol/interface standards** (USB-C/PD/EPR, USB3/4, I2C/SPI/CAN, BLE/Wi-Fi RF, HV clearance/creepage).
- **Key component datasheets**: exact pinouts, absolute-max ratings, required external passives, strapping pins, and Pin-1/polarity orientation.

### 2. Requirements & Test Integrity

- Confirm every original user requirement is physically implemented (not silently dropped, downgraded, or only checked analytically).
- Confirm `just verify` and `just check-kicad` pass with zero suppressed checks (`--ignore-*-drc`, `drcChecksDisabled`, weakened `fabRules`, skipped tests) and zero manual post-export KiCad steps.

### 3. Protocol, Electrical & Datasheet Audit

- **USB-C / High-Speed**: Separate `5.1 kΩ` `Rd` on `CC1`/`CC2` for sink ports (none on passive pass-through); `VBUS` & TVS standoff rated for max negotiated PD voltage; unbroken GND plane, matched diff pairs, low-capacitance ESD, zero stub test points.
- **Power & Battery**: Reverse-polarity & overcurrent protection; >= 2× cap voltage and resistor power derating; buck inductor `I_sat > I_peak`, feedback divider math, LDO dissipation; safe LiPo charge rate (`<= 0.5–1 C`) & back-feed isolation.
- **RF, Analog & Digital**: Copper-free antenna keepout, 50 Ω feed/matching, crystal load caps, filtered `VDDA`; pinout & polarity on every IC, MOSFET (`G/D/S`), diode, and polarized cap; open-drain pull-ups, `RESET`/`BOOT` strapping, compatible logic levels.

### 4. Mechanical, Visual & Anti-Slop Audit

- Confirm tall parts fit Z-height limits and edge connectors face outward cleanly in `pcb.svg`.
- Inspect custom footprints for pad pitch, Pin-1 mark, `<courtyardrect>`, and solderability.
- Inspect `bom.csv` (Stage 2) or `budget.bomCosts` (Stage 1) for real orderable MPN/LCSC parts and plausible pricing.
- Inspect `schematic.svg` and `pcb.svg`: `<schematicsheet>` frame, titled `<schematicbox>` blocks, compact layout, readable `<netlabel>`s without overlaps, and legible silkscreen.
- Flag dead code, unused nets, contradictory comments, and inaccurate `bringup-test-guide.md` entries.

---

## Output Format (Report Only)

```markdown
## Hardware Verification Verdict: PASS | PASS WITH MINOR NOTES | FAIL

### Critical / Blocking Defects (Must Fix)

- **[Category] `Component/File:line`** — Specific defect, violated requirement/datasheet clause, and required fix.

### Standards & Engineering Warnings

- **[Category] `Component/File:line`** — Risk or recommended hardening.

### Verified Checks

- Concise list of independently verified requirements, datasheets, and exports.
```
