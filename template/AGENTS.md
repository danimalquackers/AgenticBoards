# AgenticBoards — PCB-TDD Workspace Rules

Design fabrication- and assembly-ready PCBs using **tscircuit**, **ngspice**,
**KiCad CLI**, and **Freerouting**. Run all project commands via **`just`** (`just --list`).

## Skill Routing

Load the skill for the current phase (one source of truth per phase):

| Phase / Task                                                              | Skill                                     |
| :------------------------------------------------------------------------ | :---------------------------------------- |
| Requirements discovery, spec/tests first, live preview, incremental build | `.agents/skills/pcb-tdd/SKILL.md`         |
| Part selection, support circuitry, layout rules, domain references, SPICE | `.agents/skills/pcb-engineering/SKILL.md` |
| External routing, KiCad DRC, zone-filled Gerbers, PCBA/3D/docs release    | `.agents/skills/pcb-release/SKILL.md`     |
| Read-only Stage 1 (pre-routing) or Stage 2 (final fab) verification audit | `.agents/skills/pcb-review/SKILL.md`      |

## Non-Negotiable Invariants

1. **Red tests before `src/`**: Clarify missing constraints, encode them in `specs/board.spec.json` and `tests/board.constraints.test.ts`, and run `just test` to confirm the new tests fail before writing circuit code. Repeat for any major requirement change.
2. **Never weaken tests**: Keep every DRC, spec, and test rule active (no `--ignore-*-drc`, `drcChecksDisabled`, or loosened `fabRules`).
3. **Live preview & tight loops**: Start `just dev` (`http://localhost:3020`) once the board outline exists. Build 1–2 subcircuits at a time using `just check-placement` -> `just check-preview` -> `just check` -> `just check-status`.
4. **No ad-hoc routing scripts**: If `auto-local` fails after 3–5 targeted placement fixes, re-architect the crowded zone or run `just route` / `just route-tune`. If routing still fails, stop and ask the user.
5. **Fab-ready handoff**: Finish with `just export-all` (zero errors, zero unconnected nets) and a `pcb-review` audit before presenting the board.
