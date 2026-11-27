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
  allowPlacements: z.boolean().default(false),
  exemptComponents: z.array(z.string()).default([]),
});

export const PowerRailSchema = z
  .object({
    net: z.string().min(1),
    nominalVoltageV: z.number(),
    minVoltageV: z.number().optional(),
    maxVoltageV: z.number().optional(),
    maxCurrentA: z.number().nonnegative(),
    minTraceWidthMm: z.number().positive().optional(),
    minClearanceMm: z.number().positive().optional(),
    requiresDecoupling: z.boolean().default(true),
    notes: z.string().optional(),
  })
  .superRefine((rail, ctx) => {
    if (rail.minVoltageV !== undefined && rail.minVoltageV > rail.nominalVoltageV) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minVoltageV"],
        message: "minVoltageV must be <= nominalVoltageV",
      });
    }
    if (rail.maxVoltageV !== undefined && rail.maxVoltageV < rail.nominalVoltageV) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxVoltageV"],
        message: "maxVoltageV must be >= nominalVoltageV",
      });
    }
  });

export const NetClassSchema = z
  .object({
    name: z.string().min(1),
    nets: z.array(z.string().min(1)).min(1),
    trackWidthMm: z.number().positive().optional(),
    clearanceMm: z.number().positive().optional(),
    viaDiameterMm: z.number().positive().optional(),
    viaDrillMm: z.number().positive().optional(),
    targetImpedanceOhm: z.number().positive().optional(),
    diffPairGapMm: z.number().positive().optional(),
    notes: z.string().optional(),
  })
  .superRefine((nc, ctx) => {
    if (
      nc.viaDiameterMm !== undefined &&
      nc.viaDrillMm !== undefined &&
      nc.viaDiameterMm <= nc.viaDrillMm
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["viaDiameterMm"],
        message: "viaDiameterMm must be greater than viaDrillMm",
      });
    }
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

export const FabRulesSchema = z
  .object({
    fabHouse: z.string().default("JLCPCB"),
    minTraceWidthMm: z.number().positive().default(0.127),
    minClearanceMm: z.number().positive().default(0.127),
    minViaDrillMm: z.number().positive().default(0.3),
    minViaDiameterMm: z.number().positive().default(0.5),
    minEdgeClearanceMm: z.number().nonnegative().default(0.3),
  })
  .superRefine((fab, ctx) => {
    if (fab.minViaDiameterMm <= fab.minViaDrillMm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minViaDiameterMm"],
        message: "minViaDiameterMm must be greater than minViaDrillMm",
      });
    }
  });

export const ElectricalSchema = z.object({
  groundNetName: z.string().default("GND"),
  requireGroundNet: z.boolean().default(true),
  maxDecouplingDistanceMm: z.number().positive().default(8.0),
  maxTraceTempRiseC: z.number().positive().default(10),
  allowedUnconnectedPins: z.array(z.string()).default([]),
  requireFootprints: z.boolean().default(true),
  require3dModels: z.boolean().default(false),
});

export const SignalIntegritySchema = z.object({
  highSpeedNets: z.array(z.string()).default([]),
  differentialPairs: z.array(z.tuple([z.string(), z.string()])).default([]),
  maxDiffPairSkewMm: z.number().positive().default(0.5),
  maxTraceLengthMm: z.record(z.string(), z.number().positive()).default({}),
  buses: z.array(BusSpecSchema).default([]),
});

const ValidRegexStringSchema = z.string().refine(
  (pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  },
  { message: "namePattern must be a valid regular expression" },
);

export const BoardSpecSchema = z
  .object({
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
    fabRules: FabRulesSchema.default(() => FabRulesSchema.parse({})),

    budget: z.object({
      maxBomUsd: z.number().positive(),
      estimatedFabUnitUsd: z.number().nonnegative().default(2.0),
      maxTotalUnitUsd: z.number().positive().optional(),
      targetQuantity: z.number().int().positive().default(5),
      bomCosts: z.record(z.string(), BomEntrySchema).default({}),
    }),

    powerRails: z.array(PowerRailSchema).default([]),
    electrical: ElectricalSchema.default(() => ElectricalSchema.parse({})),
    signalIntegrity: SignalIntegritySchema.default(() => SignalIntegritySchema.parse({})),

    requiredComponents: z
      .array(
        z.object({
          description: z.string(),
          namePattern: ValidRegexStringSchema.optional(),
          ftype: z.string().optional(),
          minCount: z.number().int().positive().default(1),
        }),
      )
      .default([]),
    requiredNets: z.array(z.string()).default([]),
    simulations: z.array(SimulationSpecSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    const { exactWidthMm, maxWidthMm, exactHeightMm, maxHeightMm, layers } = spec.dimensions;
    if (exactWidthMm !== undefined && exactWidthMm > maxWidthMm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions", "exactWidthMm"],
        message: "exactWidthMm must be <= maxWidthMm",
      });
    }
    if (exactHeightMm !== undefined && exactHeightMm > maxHeightMm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions", "exactHeightMm"],
        message: "exactHeightMm must be <= maxHeightMm",
      });
    }

    const maxInner = Math.max(0, layers - 2);
    for (let i = 0; i < spec.keepoutZones.length; i++) {
      for (const layer of spec.keepoutZones[i].layers) {
        const match = layer.match(/^inner(\d+)$/);
        if (match && Number(match[1]) > maxInner) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["keepoutZones", i, "layers"],
            message: `Keepout layer "${layer}" exceeds board inner layers (${maxInner}) for a ${layers}-layer board`,
          });
        }
      }
    }
  });

export type BoardSpec = z.infer<typeof BoardSpecSchema>;
