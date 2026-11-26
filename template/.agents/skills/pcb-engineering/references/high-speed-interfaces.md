# High-Speed Interfaces Reference

Load this reference when the board includes USB 2.0/3.x, Ethernet, CAN/RS-485, MIPI, HDMI, or digital buses/clocks above 20 MHz.

## 1. Stackup & Controlled Impedance

- Use a **4-layer stackup** (`Sig / GND / PWR / Sig`) whenever routing USB, Ethernet, RF, or clocks > 20 MHz. Record the target fab stackup in `specs/board.spec.json -> dimensions.stackup` (e.g. `"JLC04161H-7628"` or `"JLC04161H-3313"`).
- Typical JLCPCB 4-layer 1.6 mm controlled-impedance targets (confirm with fab calculator before release):
  - **JLC04161H-7628** (prepreg 0.21 mm, Er ~ 4.4): ~0.35 mm for 50 Ω SE; ~0.20 mm width / 0.15 mm gap for 90 Ω diff; ~0.16 mm / 0.15 mm for 100 Ω diff.
  - **JLC04161H-3313** (prepreg 0.10 mm, Er ~ 4.05): ~0.19 mm for 50 Ω SE; ~0.12 mm / 0.13 mm for 90 Ω diff; ~0.10 mm / 0.15 mm for 100 Ω diff.
- Declare impedance-controlled nets in `specs/board.spec.json -> netClasses` so both Freerouting and KiCad DRC enforce their trace widths and clearances.

## 2. Reference Planes & Return Paths

- Route high-speed signals over an **unbroken solid GND plane** on the adjacent layer. Never cross a plane split.
- When a high-speed trace transitions between Top and Bottom layers, place a **GND stitching via** within 1–2 mm of the signal via(s) so return current does not detour.
- **No stub test points**: Never attach `<testpoint>` stubs to USB D+/D-, Ethernet, or > 50 MHz clocks.

## 3. Interface-Specific Essentials

- **USB-C (UFP / Sink)**:
  - Separate `5.1 kΩ` (1%) pull-down resistors on **both** `CC1` and `CC2` to `GND` (never tie `CC1` and `CC2` together).
  - Place a low-capacitance ESD diode array (e.g. `USBLC6-2SC6`, < 3 pF) inline right behind the receptacle with straight-through routing.
  - Declare `["USB_DP", "USB_DM"]` in `signalIntegrity.differentialPairs` with `maxDiffPairSkewMm <= 0.5` (and run `just route-tune` if needed).
- **SPI / QSPI / SDIO (> 20 MHz)**:
  - Add 22–33 Ω series source-termination resistors near the clock/data driver.
  - Keep `CLK` and data lines length-matched within ~5 mm (`signalIntegrity.maxTraceLengthMm`).
- **CAN / RS-485**:
  - Route `CAN_H`/`CAN_L` (or `A`/`B`) as a 120 Ω differential pair; include a 120 Ω termination resistor (or jumper-selectable footprint) and bus ESD/TVS protection near the connector.
  - Declare the bus in `signalIntegrity.buses` so `checks/electrical-heuristics.ts` verifies termination automatically.
