/**
 * Main PCB entrypoint. Update `specs/board.spec.json` and `tests/board.constraints.test.ts`
 * first, then compose modular subcircuits from `src/subcircuits/` here.
 */
export default () => <board width="50mm" height="50mm" layers={2} autorouter="auto-local" />
