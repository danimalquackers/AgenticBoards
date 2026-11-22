# Declarative Nix development environment for native PCB tools.
# JavaScript dependencies live in standard mutable `node_modules/` (`npm install --legacy-peer-deps`).
# Works with `nix-shell`, `nix develop`, and `direnv` via `.envrc`.
{
  pkgs ? import <nixpkgs> { },
  lib ? pkgs.lib,
  extraPackages ? [ ],
}:

let
  # Upstream `tscircuit/cli.mjs` uses a `#!/usr/bin/env bun` shebang despite being
  # standard Node ESM; wrap `tsci` so it runs cleanly under Nix's Node runtime.
  tsci = pkgs.writeShellScriptBin "tsci" ''
    if [ ! -f ./node_modules/tscircuit/cli.mjs ]; then
      echo "Error: node_modules not installed. Run: npm install --legacy-peer-deps" >&2
      exit 1
    fi
    exec ${lib.getExe pkgs.nodejs} ./node_modules/tscircuit/cli.mjs "$@"
  '';
in
pkgs.mkShell {
  name = "agentic-board";

  packages =
    (with pkgs; [
      nodejs
      tsci
      just
      biome
      ngspice
      freerouting
      kicad-small
      jq
      zip
      unzip
    ])
    ++ extraPackages;

  shellHook = ''
    # bash

    export PATH="${tsci}/bin:$PWD/node_modules/.bin:$PATH"
    export TSCI_TELEMETRY_DISABLED=1

    echo "[AgenticBoards] Shell ready: node $(node --version) | tsci | just | ngspice | kicad-cli | freerouting | biome"
    if [ ! -d node_modules ]; then
      echo "  Note: node_modules not found. Run 'npm install --legacy-peer-deps' first."
    fi
    echo "  Run 'just' to list commands (dev, verify, fmt, export-gerbers, export-pcba, export-kicad, export-all, route)"
  '';
}
