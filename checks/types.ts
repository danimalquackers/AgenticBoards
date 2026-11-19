export type Severity = "error" | "warning" | "info"

export type CheckCategory =
  | "drc"
  | "mechanical"
  | "fab"
  | "budget"
  | "electrical"
  | "power-integrity"
  | "signal-integrity"
  | "thermal"
  | "simulation"

export interface CheckFinding {
  id: string
  category: CheckCategory
  severity: Severity
  message: string
  details?: Record<string, unknown>
}

export interface BomSummary {
  totalComponents: number
  pricedComponents: number
  unpricedDesignators: string[]
  bomCostUsd: number
  estimatedFabUnitUsd: number
  totalUnitCostUsd: number
  maxBomUsd: number
  maxTotalUnitUsd?: number
}

export interface CheckReport {
  timestamp: string
  projectName: string
  entrypoint: string
  passed: boolean
  errorCount: number
  warningCount: number
  boardMetrics: {
    widthMm: number | null
    heightMm: number | null
    layers: number | null
    componentCount: number
    traceCount: number
    viaCount: number
    holeCount: number
    cadModelCount: number
  }
  bom: BomSummary
  findings: CheckFinding[]
}
