---
name: pcb-review
description: >-
  Unbiased, detail-oriented hardware design verifier run in a fresh read-only
  subagent after `just verify` and `just export-all`. Independently researches
  relevant datasheets and standards, audits the board against the original user
  requirements, and reports defects and slop without modifying any files.
---

# Independent Hardware Design Verifier (`pcb-review`)

Run this skill inside a **fresh, read-only verifier subagent** before declaring any board
complete. The verifier acts as a **fresh set of eyes**: detail-oriented, skeptical, and
**report-only** (it never edits files or attempts fixes).

## How to Launch the Verifier Subagent

Keep the handoff **unbiased**:

1. Provide **only**:
   - The user's **original requirements** (and any explicit user answers/changes).
   - Paths to the board artifacts (`specs/board.spec.json`, `tests/`, `src/`,
     `dist/checks-report.json`, `dist/exports/kicad-drc.json`, `dist/exports/bom.csv`,
     `dist/exports/schematic.svg`, `dist/exports/pcb.svg`, and `dist/exports/bringup-test-guide.md`).
2. **Do not** pass the author's design rationale, justifications, or "known minor issues"
   framing — let the verifier evaluate the board strictly on its own merits.
3. Instruct the verifier to **report findings only** and make zero file edits.
4. The verification is not adversarial, it is intended to help catch and fix unseen issues.

---

## Verification Workflow (Verifier Subagent)

### 1. Independent Research First (Do Not Trust Author Assumptions)

Before reviewing the circuit line by line, independently research the external specs and
datasheets that this board must satisfy:

- **Mechanical & enclosure standards** referenced by the prompt (e.g., official enclosure
  dimensions, PCB thickness, Z-height clearance, connector protrusion, mounting hole layout).
- **Protocol & interface specifications** (e.g., USB-C/PD/EPR, USB3/USB4/Thunderbolt,
  I2C/SPI/CAN, BLE/Wi-Fi RF layout rules).
- **Key component datasheets** (MCU/module, buck/LDO, battery charger, ESD/TVS, connectors):
  verify exact pinouts, absolute-maximum ratings, required external passives, strapping
  pins, and footprint/pin-1 orientation independently — do not assume `src/` or
  `specs/board.spec.json` got them right.

### 2. Requirements & Test Integrity Audit

- Check every original user requirement against the compiled board and `src/`. Flag
  anything silently dropped, downgraded without approval, or only checked analytically
  rather than physically implemented.
- Verify `just verify` and `just kicad-drc` pass with **zero** suppressed checks
  (`--ignore-*-drc`, `drcChecksDisabled`, weakened `fabRules`, or skipped tests).
- Flag any leftover manual post-export KiCad steps — exports must be fab-ready as generated.

### 3. Protocol, Electrical & Datasheet Audit

Audit every subsystem against the researched specs:

- **USB-C / PD / USB3 / USB4 / Thunderbolt**:
  - Sink-only ports: separate `5.1kΩ` `Rd` pull-downs on both `CC1` and `CC2`.
  - Passive pass-through ports: **no** permanent `Rd` pull-downs on `CC1`/`CC2`; `VBUS` tap
    and TVS standoff voltage must survive max negotiated PD voltage (e.g., `>= 24V` for
    `20V` PD, `>= 50V` for EPR).
  - High-speed differential pairs (`D+/D-`, `TX/RX`): unbroken ground reference plane, matched
    lengths (`<= maxDiffPairSkewMm`), ultra-low-capacitance ESD (`<= 0.5 pF` for SuperSpeed/USB4),
    and **zero** stub test points.
- **Power, Regulation & Battery (LiPo / Buck / LDO)**:
  - Reverse-polarity and overcurrent protection (polyfuse/fuse) on external inputs.
  - Capacitor voltage derating (`>= 2x` working voltage for X5R/X7R) and resistor power derating (`>= 2x`).
  - Buck inductor saturation current (`I_sat > I_peak`), feedback divider math vs target
    voltage, and LDO thermal dissipation (`P_diss = (Vin - Vout) * I`).
  - LiPo charge current (`<= 0.5C–1C` for cell capacity) and power-path / back-feed isolation.
- **RF, Analog & Digital**:
  - Antenna keepout clear of copper/ground on all layers; 50 Ω feedline/matching network;
    crystal load caps; filtered `VDDA`.
  - Pinout and polarity check on every IC, MOSFET (`D/G/S`), diode (`anode/cathode`), and
    polarized cap; pull-ups on open-drain buses (`I2C`), `RESET`/`BOOT` strapping, and
    compatible logic levels.

### 4. Mechanical, Fab Realism & Anti-Slop Audit

- Confirm tall components (modules, inductors, connectors, battery) fit enclosure Z-height
  and connector edges align with the shell.
- Inspect custom footprints for pad pitch, pin-1 alignment, `<courtyardrect>`, and
  solderability.
- Inspect `dist/exports/bom.csv` for real, orderable MPN/LCSC parts and plausible pricing
  (flag placeholder part numbers, unverified rotations, or test-point BOM clutter).
- Flag dead code, unused nets, contradictory comments, copy-pasted mismatches, and
  inaccurate or incomplete checks in `dist/exports/bringup-test-guide.md`.
- Inspect visual reviewability (`dist/exports/schematic.svg`, `pcb.svg`, and `dist/checks-report.json`
  schematic warnings): flag overly spread-out or disorganized schematics, overlapping net
  labels (`schematic_component_styling_warning`), missing logical block grouping, or
  unreadable silkscreen.

---

## Output Format (Report Only — Do Not Edit Files)

```markdown
## Hardware Verification Verdict: PASS | PASS WITH MINOR NOTES | FAIL

### Critical / Blocking Defects (Must Fix)

- **[Category] `Component/File:line`** — Specific defect, which requirement or datasheet/spec
  clause it violates, and what needs to change.

### Standards & Engineering Warnings

- ...

### Slop & Documentation Findings

- ...
```

If the verdict is **FAIL**, the main agent (not the verifier) fixes every blocking defect,
re-runs `just export-all`, and invokes a fresh verifier subagent until it returns **PASS**
(or **PASS WITH MINOR NOTES**).
