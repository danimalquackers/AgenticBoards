# Analog & Mixed-Signal Reference

Load this reference when the board includes precision ADCs/DACs (>= 12-bit), op-amp front-ends, load-cell/thermocouple/RTD interfaces, or audio codecs.

## 1. Partitioning & Grounding

- **Partition physically, keep GND unified**: Place all analog circuitry in one quiet zone and digital/switching circuitry in another, over a **single unbroken GND plane** (Layer 2 on 4-layer boards). Do not split the ground plane unless the ADC datasheet explicitly mandates an isolated barrier; bad plane splits create huge return loops.
- Ensure digital return currents never cross through the analog section by placing connectors and power entry on the digital/power side.

## 2. Clean Analog Supplies & Reference (`VDDA` / `VREF`)

- Filter `VDDA` from the digital rail using a **ferrite bead (e.g. 600 Ω @ 100 MHz) + 10 uF + 100 nF** RC/LC filter, or power it from a dedicated low-noise LDO (PSRR > 60 dB).
- Give `VREF` its own dedicated ceramic decoupling capacitor (per datasheet ESR requirements) placed right at the `VREF` and `VSSA` pins.
- Avoid routing `SW` nodes, SPI clocks, or PWM traces near `VREF` or high-impedance op-amp inverting inputs.

## 3. Signal Conditioning & Layout

- Add an **anti-aliasing RC low-pass filter** (`R_series` + C0G/NP0 `C_filt`) directly at each ADC input pin to limit bandwidth and supply the ADC sample-and-hold charge kickback.
- Use **C0G / NP0** capacitors and **0.1%–1% thin-film** resistors in precision filter, gain, and reference paths (never X5R/X7R in the signal path — microphonics and DC-bias capacitance shift distort signals).
- For high-impedance inputs (> 100 kΩ, e.g. pH probes, photodiodes, piezo), surround the input node with a **guard ring** driven at the same potential (or quiet `AGND`) to intercept PCB surface leakage.
- Simulate op-amp gain, bandwidth, phase margin, and filter cutoff frequency in `src/simulations/` using `ngspice` and assert them in `specs/board.spec.json -> simulations`.
