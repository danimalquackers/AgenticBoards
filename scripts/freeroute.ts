import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { loadSpec } from "../checks/index"

/**
 * External Autorouting Pipeline via Specctra DSN -> Freerouting -> SES.
 *
 * Use when tscircuit's built-in local capacity autorouter struggles with dense
 * multi-layer boards or when you want to compare routing solutions in KiCad.
 */

const rootDir = process.cwd()
const outDir = resolve(rootDir, "dist/routing")
mkdirSync(outDir, { recursive: true })

const spec = loadSpec("specs/board.spec.json")
const entry = resolve(rootDir, spec.entrypoint)
const dsnPath = resolve(outDir, "board.dsn")
const sesPath = resolve(outDir, "board.ses")

console.log(`[ROUTE] Exporting Specctra DSN from ${spec.entrypoint}...`)
const exp = spawnSync("tsci", ["export", "-f", "specctra-dsn", "-o", dsnPath, entry], {
  cwd: rootDir,
  stdio: "inherit",
})
if (exp.status !== 0 || !existsSync(dsnPath)) {
  console.error("[ROUTE] Failed to export Specctra DSN.")
  process.exit(1)
}

console.log("[ROUTE] Running Freerouting headless (-de board.dsn -do board.ses)...")
const fr = spawnSync("freerouting", ["-de", dsnPath, "-do", sesPath, "-mp", "40"], {
  cwd: rootDir,
  stdio: "inherit",
})

if (fr.status !== 0 || !existsSync(sesPath)) {
  console.error("[ROUTE] Freerouting exited with an error or did not emit board.ses.")
  process.exit(fr.status ?? 1)
}

console.log(`\n[ROUTE] Success! Routed Specctra session saved to: ${sesPath}`)
console.log("  You can import this .ses file into KiCad (File -> Import -> Specctra Session)")
console.log("  on dist/exports/board.kicad_pcb, or convert/inspect traces programmatically.")
