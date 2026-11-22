import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Repairs missing `Via[...]` padstack declarations in a Specctra DSN file, runs
 * headless `freerouting`, and fails loudly if Freerouting rejects the DSN.
 */
const dsnPath = resolve(process.cwd(), process.argv[2] ?? "dist/exports/board.dsn");
const sesPath = resolve(process.cwd(), process.argv[3] ?? "dist/routing/board.ses");
const passes = process.argv[4] ?? "40";

function repairMissingViaPadstacks(dsn: string): { text: string; patched: string[] } {
  const referenced = new Set<string>();
  for (const match of dsn.matchAll(/\bVia\[[^\s()"]+\]/g)) {
    referenced.add(match[0]);
  }

  const missing: string[] = [];
  for (const name of referenced) {
    if (!dsn.includes(`(padstack "${name}"`) && !dsn.includes(`(padstack ${name}`)) {
      missing.push(name);
    }
  }

  if (missing.length === 0) return { text: dsn, patched: [] };

  const padstackDefs = missing.map((name) => {
    const dims = name.match(/_(\d+):(\d+)_um$/);
    const outerUm = dims ? Number(dims[1]) : 600;
    return [
      `    (padstack "${name}"`,
      `      (shape (circle F.Cu ${outerUm}))`,
      `      (shape (circle B.Cu ${outerUm}))`,
      "      (attach off)",
      "    )",
    ].join("\n");
  });

  const libIdx = dsn.indexOf("(library");
  if (libIdx < 0) return { text: dsn, patched: [] };

  const insertAt = dsn.indexOf("\n", libIdx);
  if (insertAt < 0) return { text: dsn, patched: [] };

  const patchedText = `${dsn.slice(0, insertAt + 1)}${padstackDefs.join("\n")}\n${dsn.slice(insertAt + 1)}`;
  return { text: patchedText, patched: missing };
}

if (!existsSync(dsnPath)) {
  console.error(`[FREEROUTING] DSN file not found: ${dsnPath}`);
  process.exit(1);
}

const rawDsn = readFileSync(dsnPath, "utf8");
const { text: fixedDsn, patched } = repairMissingViaPadstacks(rawDsn);
if (patched.length > 0) {
  writeFileSync(dsnPath, fixedDsn);
  console.log(`[FREEROUTING] Added missing DSN via padstack(s): ${patched.join(", ")}`);
}

mkdirSync(dirname(sesPath), { recursive: true });

const proc = spawnSync("freerouting", ["-de", dsnPath, "-do", sesPath, "-mp", passes], {
  encoding: "utf8",
  timeout: 180_000,
});

const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
const parseFailed =
  combined.includes("DSN structure parsing failed") ||
  combined.includes("Restored tutorial_board.dsn");

if (proc.status !== 0 || parseFailed || !existsSync(sesPath) || statSync(sesPath).size < 600) {
  console.error("[FREEROUTING] Routing failed (DSN parse error or invalid SES output).");
  if (combined.trim()) console.error(combined.trim().slice(-2000));
  process.exit(1);
}

console.log(`[FREEROUTING] Routed session written to ${sesPath}`);
