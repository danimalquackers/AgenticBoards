import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadSpec, runAllBoardChecks } from "../checks/index"

/**
 * Full Manufacturing & Visualization Export Pipeline.
 * Generates renders, Gerbers, KiCad project, 3D STEP/glTF, Specctra DSN,
 * and BOM CSV into `dist/exports/`, then runs optional `kicad-cli` DRC.
 */

const rootDir = process.cwd()
const outDir = resolve(rootDir, "dist/exports")
mkdirSync(outDir, { recursive: true })

const spec = loadSpec("specs/board.spec.json")
const entry = resolve(rootDir, spec.entrypoint)

// Ensure fresh circuit.json and verification report
const report = await runAllBoardChecks("specs/board.spec.json")
if (!report.passed) {
  console.warn(
    `[WARN] Exporting despite ${report.errorCount} verification error(s). Review dist/checks-report.json before fab!`,
  )
}

const exportsToRun: Array<{ format: string; file: string; required?: boolean }> = [
  { format: "schematic-svg", file: "schematic.svg", required: true },
  { format: "pcb-svg", file: "pcb.svg", required: true },
  { format: "assembly-svg", file: "assembly.svg" },
  { format: "gerbers", file: "gerbers.zip", required: true },
  { format: "kicad_zip", file: "kicad-project.zip", required: true },
  { format: "kicad_pcb", file: "board.kicad_pcb" },
  { format: "kicad_sch", file: "board.kicad_sch" },
  { format: "step", file: "board.step" },
  { format: "gltf", file: "board.gltf" },
  { format: "specctra-dsn", file: "board.dsn" },
  { format: "readable-netlist", file: "netlist.txt" },
]

const manifest: Array<{ format: string; file: string; ok: boolean; error?: string }> = []

for (const item of exportsToRun) {
  const dest = resolve(outDir, item.file)
  const proc = spawnSync("tsci", ["export", "-f", item.format, "-o", dest, entry], {
    cwd: rootDir,
    encoding: "utf8",
  })
  const ok = proc.status === 0 && existsSync(dest)
  manifest.push({
    format: item.format,
    file: `dist/exports/${item.file}`,
    ok,
    error: ok ? undefined : (proc.stderr || proc.stdout || "export failed").trim(),
  })
  console.log(
    `[EXPORT] ${item.format.padEnd(16)} -> ${item.file.padEnd(20)} ${ok ? "OK" : "SKIP/FAIL"}`,
  )
}

// Generate BOM CSV from compiled Circuit JSON + specs/board.spec.json pricing
const circuitJson = JSON.parse(readFileSync(resolve(rootDir, "dist/circuit.json"), "utf8"))
const bomRows = ["Designator,Type,MPN,LCSC,UnitCostUSD,Notes"]
for (const el of circuitJson) {
  if (el?.type !== "source_component") continue
  const name = String(el.name ?? "")
  const cost = spec.budget.bomCosts[name]
  const lcsc = cost?.lcsc ?? el.supplier_part_numbers?.jlcpcb?.[0] ?? ""
  bomRows.push(
    [name, el.ftype ?? "", cost?.mpn ?? "", lcsc, cost?.unitCostUsd ?? "", cost?.notes ?? ""]
      .map((v) => `"${String(v).replaceAll('"', '""')}"`)
      .join(","),
  )
}
writeFileSync(resolve(outDir, "bom.csv"), `${bomRows.join("\n")}\n`)
manifest.push({ format: "bom-csv", file: "dist/exports/bom.csv", ok: true })

// Optional independent KiCad CLI DRC cross-check on exported board.kicad_pcb
const kicadPcb = resolve(outDir, "board.kicad_pcb")
if (existsSync(kicadPcb)) {
  const kicadDrcOut = resolve(outDir, "kicad-drc.json")
  const kicadProc = spawnSync(
    "kicad-cli",
    ["pcb", "drc", "--format", "json", "--output", kicadDrcOut, kicadPcb],
    { cwd: rootDir, encoding: "utf8" },
  )
  const kicadOk = kicadProc.status === 0 && existsSync(kicadDrcOut)
  console.log(
    `[KICAD-DRC] independent cross-check: ${kicadOk ? "OK (see dist/exports/kicad-drc.json)" : "SKIPPED"}`,
  )
}

writeFileSync(
  resolve(outDir, "manifest.json"),
  JSON.stringify({ timestamp: new Date().toISOString(), items: manifest }, null, 2),
)
console.log("\nExports complete. Manifest written to dist/exports/manifest.json")
