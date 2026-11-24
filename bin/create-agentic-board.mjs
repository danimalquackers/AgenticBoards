#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const TEMPLATE_DIR = resolve(ROOT_DIR, "template");
const { version } = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf8"));

const NIX_FILES = new Set(["flake.nix", "flake.lock", "shell.nix", "treefmt.nix", ".envrc"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".direnv", ".git"]);

// Framework files safe to overwrite during `--update` (never touches `src/`, `specs/board.spec.json`, `tests/`, or `package.json`).
const MANAGED_PATHS = [
  ".agents",
  "AGENTS.md",
  "checks",
  "scripts",
  "specs/board-spec.schema.ts",
  "justfile",
  "biome.json",
  "tsconfig.json",
  "tscircuit.config.json",
];
const MANAGED_NIX_FILES = ["flake.nix", "shell.nix", "treefmt.nix", ".envrc"];

function slugify(input) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "my-board";
}

function hasCommand(cmd) {
  return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

function makeWritable(targetPath) {
  const stat = statSync(targetPath);

  if (stat.isFile()) {
    chmodSync(targetPath, stat.mode | 0o200);
    return;
  }

  chmodSync(targetPath, stat.mode | 0o700);

  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const fullPath = resolve(targetPath, entry.name);

    if (entry.isDirectory()) {
      makeWritable(fullPath);
    } else if (entry.isFile()) {
      chmodSync(fullPath, statSync(fullPath).mode | 0o200);
    }
  }
}

function updateJson(filePath, mutate) {
  if (!existsSync(filePath)) return;

  const data = JSON.parse(readFileSync(filePath, "utf8"));
  mutate(data);
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function resolveTargetDir(arg, program) {
  if (arg) return arg;
  if (!process.stdin.isTTY) program.help({ error: true });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Project directory (e.g. my-board): ")).trim();
  rl.close();

  if (!answer) {
    console.error("Aborted: project directory is required.");
    process.exit(1);
  }

  return answer;
}

function copyTemplate(targetDir, { useNix }) {
  mkdirSync(targetDir, { recursive: true });

  cpSync(TEMPLATE_DIR, targetDir, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return !SKIP_DIRS.has(name) && (useNix || !NIX_FILES.has(name));
    },
  });

  makeWritable(targetDir);
}

function patchProjectMetadata(targetDir, projectName) {
  const readmePath = resolve(targetDir, "README.md");
  if (existsSync(readmePath)) {
    const updated = readFileSync(readmePath, "utf8").replaceAll("__PROJECT_NAME__", projectName);
    writeFileSync(readmePath, updated);
  }

  updateJson(resolve(targetDir, "specs/board.spec.json"), (spec) => {
    spec.projectName = projectName;
  });

  updateJson(resolve(targetDir, "package.json"), (pkg) => {
    pkg.name = projectName;
  });

  updateJson(resolve(targetDir, "package-lock.json"), (lock) => {
    lock.name = projectName;
    if (lock.packages?.[""]) lock.packages[""].name = projectName;
  });

  const hookPath = resolve(targetDir, ".agents/hooks/verify-before-stop.sh");
  if (existsSync(hookPath)) chmodSync(hookPath, 0o755);
}

function initializeProject(targetDir, projectName, { shouldInstall, useGit }) {
  let installed = false;

  if (shouldInstall && hasCommand("npm")) {
    console.log(`\nInstalling npm dependencies in ${projectName}...`);
    const result = spawnSync("npm", ["install", "--legacy-peer-deps"], {
      cwd: targetDir,
      stdio: "inherit",
    });
    installed = result.status === 0;
  }

  if (useGit && hasCommand("git")) {
    spawnSync("git", ["init", "-q"], { cwd: targetDir });
    spawnSync("git", ["add", "-A"], { cwd: targetDir });
  }

  return installed;
}

function printNextSteps({ projectName, targetArg, targetDir, useNix, nixAvailable, installed }) {
  console.log(`\nCreated PCB project "${projectName}" at ${targetDir}`);
  console.log("\nNext steps:");
  console.log(`  cd ${targetArg}`);

  if (useNix && nixAvailable) {
    console.log("  direnv allow          # or `nix develop` / `nix-shell`");
    if (!installed) console.log("  npm install --legacy-peer-deps");
    console.log("  just verify           # confirm toolchain & checks pass");
  } else {
    if (!installed) console.log("  npm install --legacy-peer-deps");
    console.log("  just doctor           # verify node, ngspice, kicad-cli, freerouting");
    console.log("  just verify           # run typecheck, lint, and TDD checks");
  }

  console.log(
    "  Open the folder in your AI coding agent and describe your PCB goals & constraints.",
  );
}

function updateExistingProject(targetDir, { useNix }) {
  const looksLikeProject =
    existsSync(resolve(targetDir, "specs/board.spec.json")) ||
    existsSync(resolve(targetDir, "package.json"));

  if (!existsSync(targetDir) || !looksLikeProject) {
    console.error(
      `Error: "${targetDir}" does not look like an existing AgenticBoards project (missing package.json and specs/board.spec.json).`,
    );
    process.exit(1);
  }

  const hasNix =
    existsSync(resolve(targetDir, "flake.nix")) || existsSync(resolve(targetDir, "shell.nix"));
  const pathsToSync = [...MANAGED_PATHS, ...(useNix && hasNix ? MANAGED_NIX_FILES : [])];

  const updated = [];

  for (const relPath of pathsToSync) {
    const src = resolve(TEMPLATE_DIR, relPath);
    const dst = resolve(targetDir, relPath);
    if (!existsSync(src)) continue;

    mkdirSync(dirname(dst), { recursive: true });
    if (existsSync(dst)) makeWritable(dst);
    cpSync(src, dst, { recursive: true, force: true });
    makeWritable(dst);
    updated.push(relPath);
  }

  const hookPath = resolve(targetDir, ".agents/hooks/verify-before-stop.sh");
  if (existsSync(hookPath)) chmodSync(hookPath, 0o755);

  console.log(`\nUpdated AgenticBoards framework files in ${targetDir}:`);
  for (const relPath of updated) {
    console.log(`  - ${relPath}`);
  }
  console.log(
    "\nPreserved user PCB files (src/, specs/board.spec.json, tests/, package.json, README.md).",
  );
  console.log("Review changes with `git diff` and run `just verify` to confirm checks pass.");
}

const program = new Command()
  .name("create-agentic-board")
  .description(
    "Scaffold a TDD-driven, fab-ready PCB project powered by tscircuit, ngspice, KiCad CLI, Freerouting, and just.",
  )
  .version(version)
  .argument("[project-dir]", "Target directory (defaults to `.` when --update is set)")
  .option(
    "-u, --update",
    "Update framework files (skills, checks, scripts, justfile, configs) in an existing project without overwriting PCB files",
  )
  .option("--no-nix", "Omit Nix and direnv files (flake.nix, shell.nix, treefmt.nix, .envrc)")
  .option("--no-git", "Skip `git init && git add -A`")
  .option("--no-install", "Skip running `npm install --legacy-peer-deps`")
  .action(async (dirArg, opts) => {
    const useNix = opts.nix !== false;

    if (opts.update) {
      const targetDir = resolve(process.cwd(), dirArg ?? ".");
      updateExistingProject(targetDir, { useNix });
      return;
    }

    const targetArg = await resolveTargetDir(dirArg, program);
    const targetDir = resolve(process.cwd(), targetArg);
    const projectName = slugify(basename(targetDir));

    if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
      console.error(`Error: target directory "${targetDir}" already exists and is not empty.`);
      process.exit(1);
    }

    const useGit = opts.git !== false;
    const nixAvailable = hasCommand("nix");
    const shouldInstall = opts.install !== false;

    copyTemplate(targetDir, { useNix });
    patchProjectMetadata(targetDir, projectName);
    const installed = initializeProject(targetDir, projectName, { shouldInstall, useGit });
    printNextSteps({ projectName, targetArg, targetDir, useNix, nixAvailable, installed });
  });

await program.parseAsync(process.argv);
