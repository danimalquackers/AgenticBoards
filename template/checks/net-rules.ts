import type { BoardSpec } from "../specs/board-spec.schema";

export interface ResolvedNetClass {
  name: string;
  nets: string[];
  trackWidthMm: number;
  clearanceMm: number;
  viaDiameterMm: number;
  viaDrillMm: number;
  diffPairGapMm?: number;
}

/**
 * IPC-2221 trace width (mm) required for `currentA` at `tempRiseC`
 * and `copperOz` oz/ft^2 copper weight.
 */
export function ipc2221MinTraceWidthMm(
  currentA: number,
  tempRiseC: number,
  copperOz: number,
  isInternal = false,
): number {
  if (currentA <= 0) return 0;

  const k = isInternal ? 0.024 : 0.048;
  const areaMil2 = (currentA / (k * tempRiseC ** 0.44)) ** (1 / 0.725);
  const thicknessMil = copperOz * 1.378;
  return (areaMil2 / thicknessMil) * 0.0254;
}

export function requiredRailWidthMm(
  rail: BoardSpec["powerRails"][number],
  spec: BoardSpec,
  isInternal = false,
): number {
  const ipcMin = ipc2221MinTraceWidthMm(
    rail.maxCurrentA,
    spec.electrical.maxTraceTempRiseC,
    spec.dimensions.copperWeightOz,
    isInternal,
  );

  return Math.max(ipcMin, rail.minTraceWidthMm ?? 0);
}

/**
 * Resolves explicit `spec.netClasses` plus synthesized `rail_<net>` classes for
 * power rails whose width or clearance exceeds `fabRules` defaults.
 * Each net belongs to at most one resolved class (`spec.netClasses` takes precedence).
 */
export function resolveNetClassRules(spec: BoardSpec): ResolvedNetClass[] {
  const fab = spec.fabRules;
  const resolved: ResolvedNetClass[] = [];
  const assignedNets = new Set<string>();

  for (const nc of spec.netClasses ?? []) {
    const uniqueNets = nc.nets.filter((n) => !assignedNets.has(n));
    if (uniqueNets.length === 0) continue;
    for (const n of uniqueNets) assignedNets.add(n);

    resolved.push({
      name: nc.name,
      nets: uniqueNets,
      trackWidthMm: Number(
        Math.max(fab.minTraceWidthMm, nc.trackWidthMm ?? fab.minTraceWidthMm).toFixed(4),
      ),
      clearanceMm: Number(
        Math.max(fab.minClearanceMm, nc.clearanceMm ?? fab.minClearanceMm).toFixed(4),
      ),
      viaDiameterMm: nc.viaDiameterMm ?? fab.minViaDiameterMm,
      viaDrillMm: nc.viaDrillMm ?? fab.minViaDrillMm,
      ...(nc.diffPairGapMm !== undefined ? { diffPairGapMm: nc.diffPairGapMm } : {}),
    });
  }

  for (const rail of spec.powerRails) {
    if (assignedNets.has(rail.net)) continue;

    const reqWidthMm = requiredRailWidthMm(rail, spec, false);
    const reqClearanceMm = Math.max(fab.minClearanceMm, rail.minClearanceMm ?? 0);
    if (reqWidthMm <= fab.minTraceWidthMm + 1e-3 && reqClearanceMm <= fab.minClearanceMm + 1e-3) {
      continue;
    }

    assignedNets.add(rail.net);
    resolved.push({
      name: `rail_${rail.net}`,
      nets: [rail.net],
      trackWidthMm: Number(Math.max(fab.minTraceWidthMm, reqWidthMm).toFixed(4)),
      clearanceMm: Number(reqClearanceMm.toFixed(4)),
      viaDiameterMm: fab.minViaDiameterMm,
      viaDrillMm: fab.minViaDrillMm,
    });
  }

  return resolved;
}
