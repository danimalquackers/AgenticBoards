# High-Voltage & Isolation Reference

Load this reference when the board handles voltages > 48 V DC, AC mains (120/240 VAC), PoE (57 V), or galvanic isolation barriers.

## 1. Clearance & Creepage Rules (IPC-2221B / IEC 62368-1 Guidance)

Use conservative spacing between high-voltage nets and low-voltage/GND nets (coated external layers, Pollution Degree 2; increase further for uncoated/harsh environments):

| Peak Working Voltage    | Min External Clearance (Soldermask) | Min Internal Clearance | Recommended Mains / Reinforced Creepage |
| :---------------------- | :---------------------------------: | :--------------------: | :-------------------------------------: |
| 50–100 V                |               0.6 mm                |        0.25 mm         |               1.5–2.0 mm                |
| 101–150 V               |               0.8 mm                |         0.4 mm         |               2.0–3.0 mm                |
| 151–300 V (120/240 VAC) |               1.5 mm                |         0.8 mm         |         4.0–6.4 mm (reinforced)         |
| 301–500 V               |               2.5 mm                |         1.5 mm         |         6.4–8.0 mm (reinforced)         |

- **Enforce in spec**: Declare every high-voltage rail/net in `specs/board.spec.json -> netClasses` (or `powerRails[].minClearanceMm`) with the required `clearanceMm`. Both `scripts/freeroute.ts` and `scripts/sync-kicad-project.ts` propagate these netclasses into Freerouting and KiCad DRC automatically.

## 2. Isolation Barriers & Keepouts

- Separate Primary (HV) and Secondary (SELV/LV) domains with a continuous, clearly labeled **isolation barrier** across ALL layers using `keepoutZones` (`"layers": ["all"]`).
- Only safety-rated bridging components may straddle the barrier: optocouplers, digital isolators, isolated DC-DC converters, transformers, or Y1/Y2 safety capacitors.
- Where board width is tight, add a **milled air-gap slot** (non-plated cutout >= 1.5–2.0 mm wide) under bridging components to increase creepage distance.
- Never place mounting holes, silkscreen text, or copper pours inside the isolation barrier.

## 3. Protection & Safety Components

- **AC Mains entry**: Always include a **mains-rated fuse** (slow-blow or fast-acting, >= 250 VAC, breaking capacity >= 35 A) on the Line (`L`) input, followed by an **MOV / TVS** surge protector and **X2** safety capacitor if EMI filtering is required.
- **HV DC / Relay / Inductive loads**: Include flyback diodes/RC snubbers across coils and contacts, and a bleeder resistor across bulk HV capacitors so stored energy discharges to safe levels (< 60 V) after power-off.
- Mark the HV zone clearly on silkscreen (`"HIGH VOLTAGE"` + dashed isolation line) on both top and bottom layers.
