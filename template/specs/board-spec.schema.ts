import { z } from "zod";

/**
 * Declarative PCB Specification Schema (TDD Contract).
 * Define constraints in `specs/board.spec.json` BEFORE editing circuits.
 */

export const MountingHoleSchema = z.object({
  name: z.string().optional(),
  xMm: z.number(),
  yMm: z.number(),
  diameterMm: z.number().positive(),
  toleranceMm: z.number().nonnegative().default(0.25),
});

const KeepoutLayerSchema = z
  .string()
  .regex(/^(top|bottom|all|inner[1-9]\d*)$/, 'Layer must be "top", "bottom", "all", or "inner<N>"');

export const KeepoutZoneSchema = z.object({
  name: z.string(),
  xMm: z.number(),
  yMm: z.number(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  layers: z.array(KeepoutLayerSchema).default(["all"]),
});

export const PowerRailSchema = z.object({
  net: z.string().min(1),
  nominalVoltageV: z.number(),
  minVoltageV: z.number().optional(),
  maxVoltageV: z.number().optional(),
  maxCurrentA: z.number().nonnegative(),
  minTraceWidthMm: z.number().positive().optional(),
  minClearanceMm: z.number().positive().optional(),
  requiresDecoupling: z.boolean().default(true),
  notes: z.string().optional(),
});

export const NetClassSchema = z.object({
  name: z.string().min(1),
  nets: z.array(z.string().min(1)).min(1),
  trackWidthMm: z.number().positive().optional(),
  clearanceMm: z.number().positive().optional(),
  viaDiameterMm: z.number().positive().optional(),
  viaDrillMm: z.number().positive().optional(),
  targetImpedanceOhm: z.number().positive().optional(),
  diffPairGapMm: z.number().positive().optional(),
  notes: z.string().optional(),
});

export const BusSpecSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(["i2c", "can", "rs485", "uart", "spi", "usb2"]),
  nets: z.array(z.string().min(1)).min(1),
  pullUpRail: z.string().min(1).optional(),
  requirePullUps: z.boolean().optional(),
  requireTermination: z.boolean().optional(),
});

export const BomEntrySchema = z.object({
  mpn: z.string().optional(),
  lcsc: z.string().optional(),
  supplier: z.string().optional(),
  unitCostUsd: z.number().nonnegative(),
  heightMm: z.number().positive().optional(),
  notes: z.string().optional(),
});

export const SimulationSpecSchema = z.object({
  name: z.string(),
  file: z.string(),
  engine: z.enum(["ngspice", "spicey"]).default("ngspice"),
  assertions: z
    .array(
      z.object({
        probe: z.string().min(1),
        metric: z.enum(["avg", "min", "max", "final", "ripple"]),
        min: z.number().optional(),
        max: z.number().optional(),
        unit: z.string().default("V"),
      }),
    )
    .default([]),
});

export const BoardSpecSchema = z.object({
  projectName: z.string().min(1),
  description: z.string().min(1),
  revision: z.string().default("0.1.0"),
  entrypoint: z.string().default("src/boards/main.circuit.tsx"),

  dimensions: z.object({
    maxWidthMm: z.number().positive(),
    maxHeightMm: z.number().positive(),
    exactWidthMm: z.number().positive().optional(),
    exactHeightMm: z.number().positive().optional(),
    toleranceMm: z.number().nonnegative().default(0.2),
    thicknessMm: z.number().positive().default(1.6),
    maxTopHeightMm: z.number().positive().optional(),
    maxBottomHeightMm: z.number().positive().optional(),
    layers: z
      .number()
      .int()
      .refine((v) => v === 1 || (v >= 2 && v % 2 === 0), {
        message: "layers must be 1 or an even integer >= 2",
      }),
    copperWeightOz: z.number().positive().default(1),
    stackup: z.string().optional(),
  }),

  mountingHoles: z.array(MountingHoleSchema).default([]),
  keepoutZones: z.array(KeepoutZoneSchema).default([]),
  netClasses: z.array(NetClassSchema).default([]),

  fabRules: z
    .object({
      fabHouse: z.string().default("JLCPCB"),
      minTraceWidthMm: z.number().positive().default(0.127),
      minClearanceMm: z.number().positive().default(0.127),
      minViaDrillMm: z.number().positive().default(0.3),
      minViaDiameterMm: z.number().positive().default(0.5),
      minEdgeClearanceMm: z.number().nonnegative().default(0.3),
    })
    .default({
      fabHouse: "JLCPCB",
      minTraceWidthMm: 0.127,
      minClearanceMm: 0.127,
      minViaDrillMm: 0.3,
      minViaDiameterMm: 0.5,
      minEdgeClearanceMm: 0.3,
    }),

  budget: z.object({
    maxBomUsd: z.number().positive(),
    estimatedFabUnitUsd: z.number().nonnegative().default(2.0),
    maxTotalUnitUsd: z.number().positive().optional(),
    targetQuantity: z.number().int().positive().default(5),
    bomCosts: z.record(z.string(), BomEntrySchema).default({}),
  }),

  powerRails: z.array(PowerRailSchema).default([]),

  electrical: z
    .object({
      groundNetName: z.string().default("GND"),
      requireGroundNet: z.boolean().default(true),
      maxDecouplingDistanceMm: z.number().positive().default(8.0),
      maxTraceTempRiseC: z.number().positive().default(10),
      allowedUnconnectedPins: z.array(z.string()).default([]),
      requireFootprints: z.boolean().default(true),
      require3dModels: z.boolean().default(false),
    })
    .default({
      groundNetName: "GND",
      requireGroundNet: true,
      maxDecouplingDistanceMm: 8.0,
      maxTraceTempRiseC: 10,
      allowedUnconnectedPins: [],
      requireFootprints: true,
      require3dModels: false,
    }),

  signalIntegrity: z
    .object({
      highSpeedNets: z.array(z.string()).default([]),
      differentialPairs: z.array(z.tuple([z.string(), z.string()])).default([]),
      maxDiffPairSkewMm: z.number().positive().default(0.5),
      maxTraceLengthMm: z.record(z.string(), z.number().positive()).default({}),
      buses: z.array(BusSpecSchema).default([]),
    })
    .default({
      highSpeedNets: [],
      differentialPairs: [],
      maxDiffPairSkewMm: 0.5,
      maxTraceLengthMm: {},
      buses: [],
    }),

  requiredComponents: z
    .array(
      z.object({
        description: z.string(),
        namePattern: z.string().optional(),
        ftype: z.string().optional(),
        minCount: z.number().int().positive().default(1),
      }),
    )
    .default([]),
  requiredNets: z.array(z.string()).default([]),
  simulations: z.array(SimulationSpecSchema).default([]),
});

export type BoardSpec = z.infer<typeof BoardSpecSchema>;
