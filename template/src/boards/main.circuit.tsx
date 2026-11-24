/**
 * Main PCB entrypoint. Update `specs/board.spec.json` and `tests/board.constraints.test.ts`
 * first, then compose modular subcircuits from `src/subcircuits/` here.
 */
export default () => (
  <board
    width="50mm"
    height="50mm"
    layers={2}
    autorouter="auto-local"
    defaultTraceWidth="0.16mm"
    minTraceWidth="0.15mm"
    minViaHoleDiameter="0.3mm"
    minViaPadDiameter="0.6mm"
    minBoardEdgeClearance="0.35mm"
    minTraceToPadEdgeClearance="0.15mm"
    pcbStyle={{ viaHoleDiameter: "0.3mm", viaPadDiameter: "0.6mm" }}
  >
    <schematicsheet name="main" displayName="Main Schematic" sheetSize="A4" />
  </board>
);
