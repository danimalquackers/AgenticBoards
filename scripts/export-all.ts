import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { convertCircuitJsonToPickAndPlaceCsv } from "circuit-json-to-pnp-csv"
import { loadSpec, runAllBoardChecks } from "../checks/index"

/**
 * Manufacturing, PCBA & Visualization Export Pipeline.
 * Generates SVGs, Gerbers, KiCad project, STEP/glTF 3D, DSN, JLCPCB BOM CSV,
 * Pick-and-Place CPL CSV, and runs an independent `kicad-cli pcb drc` gate.
 */

const force = process.argv.includes("--force")
const rootDir = process.cwd()
const outDir = resolve(rootDir, "dist/exports")
mkdirSync(outDir, { recursive: true })

const spec = loadSpec("specs/board.spec.json")
const entry = resolve(rootDir, spec.entrypoint)

const report = await runAllBoardChecks("specs/board.spec.json")
if (!report.passed) {
  console.error(`[FAIL] Board verification has ${report.errorCount} error(s).`)
  if (!force) {
    console.error("Fix dist/checks-report.json errors first, or pass --force to export anyway.")
    process.exit(1)
  }
}

const exportsToRun: Array<{ format: string; file: string; required?: boolean }> = [
  { format: "schematic-svg", file: "schematic.svg", required: true },
  { format: "pcb-svg", file: "pcb.svg", required: true },
  { format: "assembly-svg", file: "assembly.svg" },
  { format: "gerbers", file: "gerbers.zip", required: true },
  { format: "kicad_zip", file: "kicad-project.zip", required: true },
  { format: "kicad_pcb", file: "board.kicad_pcb", required: true },
  { format: "kicad_sch", file: "board.kicad_sch", required: true },
  { format: "step", file: "board.step" },
  { format: "gltf", file: "board.gltf" },
  { format: "specctra-dsn", file: "board.dsn" },
  { format: "readable-netlist", file: "netlist.txt" },
]

const manifest: Array<{ format: string; file: string; ok: boolean; error?: string }> = []
let missingRequired = 0

for (const item of exportsToRun) {
  const dest = resolve(outDir, item.file)
  const proc = spawnSync("tscircuit-cli", ["export", "-f", item.format, "-o", dest, entry], {
    cwd: rootDir,
    encoding: "utf8",
  })
  const ok = proc.status === 0 && existsSync(dest)
  if (!ok && item.required) missingRequired += 1
  manifest.push({
    format: item.format,
    file: `dist/exports/${item.file}`,
    ok,
    error: ok ? undefined : (proc.stderr || proc.stdout || "export failed").trim(),
  })
  console.log(
    `[EXPORT] ${item.format.padEnd(16)} -> ${item.file.padEnd(20)} ${ok ? "OK" : item.required ? "FAIL" : "SKIP"}`,
  )
}

// Generate JLCPCB-compatible BOM CSV & Pick-and-Place (CPL) CSV
const circuitJson = JSON.parse(readFileSync(resolve(rootDir, "dist/circuit.json"), "utf8"))
const pcbBySource = new Map<string, any>(
  circuitJson
    .filter((el: any) => el?.type === "pcb_component")
    .map((pc: any) => [pc.source_component_id, pc]),
)

const bomRows = ["Comment,Designator,Footprint,LCSC Part #,MPN,UnitCostUSD,Notes"]
for (const el of circuitJson) {
  if (el?.type !== "source_component") continue
  const name = String(el.name ?? "")
  const cost = spec.budget.bomCosts[name]
  const lcsc = cost?.lcsc ?? el.supplier_part_numbers?.jlcpcb?.[0] ?? ""
  const comment = el.display_resistance ?? el.display_capacitance ?? cost?.mpn ?? el.ftype ?? name
  const fp = pcbBySource.get(el.source_component_id)?.footprint_name ?? ""
  bomRows.push(
    [comment, name, fp, lcsc, cost?.mpn ?? "", cost?.unitCostUsd ?? "", cost?.notes ?? ""]
      .map((v) => `"${String(v).replaceAll('"', '""')}"`)
      .join(","),
  )
}
writeFileSync(resolve(outDir, "bom.csv"), `${bomRows.join("\n")}\n`)
manifest.push({ format: "bom-csv", file: "dist/exports/bom.csv", ok: true })

const pnpCsv = convertCircuitJsonToPickAndPlaceCsv(circuitJson)
writeFileSync(resolve(outDir, "pnp.csv"), pnpCsv)
manifest.push({ format: "pnp-csv", file: "dist/exports/pnp.csv", ok: true })
console.log("[EXPORT] bom-csv + pnp-csv -> bom.csv, pnp.csv      OK")

// Independent KiCad CLI DRC cross-check on exported board.kicad_pcb
let kicadErrors = 0
const kicadPcb = resolve(outDir, "board.kicad_pcb")
if (existsSync(kicadPcb)) {
  const kicadDrcOut = resolve(outDir, "kicad-drc.json")
  spawnSync("kicad-cli", ["pcb", "drc", "--format", "json", "--output", kicadDrcOut, kicadPcb], {
    cwd: rootDir,
    encoding: "utf8",
  })
  if (existsSync(kicadDrcOut)) {
    const drc = JSON.parse(readFileSync(kicadDrcOut, "utf8"))
    const violations = (drc.violations ?? []).filter((v: any) => v.severity === "error")
    const unconnected = drc.unconnected_items ?? []
    kicadErrors = violations.length + unconnected.length
    console.log(
      `[KICAD-DRC] ${kicadErrors === 0 ? "PASS" : "FAIL"} (${violations.length} error(s), ${unconnected.length} unconnected net(s)) -> dist/exports/kicad-drc.json`,
    )
  }
}

writeFileSync(
  resolve(outDir, "manifest.json"),
  JSON.stringify({ timestamp: new Date().toISOString(), kicadErrors, items: manifest }, null, 2),
)
if ((kicadErrors > 0 || missingRequired > 0) && !force) process.exit(1)
console.log("\nExports ready in dist/exports/ (manifest.json).")
