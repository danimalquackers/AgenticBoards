# Declarative Nix development environment for AgenticBoards.
# Works with `nix-shell`, `nix develop`, and `direnv` via `.envrc`.
{ pkgs ? import <nixpkgs> { } }:

let
  nodeModules = pkgs.importNpmLock.buildNodeModules {
    npmRoot = ./.;
    inherit (pkgs) nodejs;
    derivationArgs = {
      npmFlags = [ "--legacy-peer-deps" ];
    };
  };

  # Upstream `tscircuit/cli.mjs` uses a `#!/usr/bin/env bun` shebang despite being
  # standard Node ESM; wrap `tsci` so it runs cleanly under Nix's Node 24 runtime.
  tsci = pkgs.writeShellScriptBin "tsci" ''
    exec ${pkgs.nodejs}/bin/node "${nodeModules}/node_modules/tscircuit/cli.mjs" "$@"
  '';
in
pkgs.mkShell {
  name = "agentic-boards";

  packages = with pkgs; [
    nodejs
    tsci
    biome
    ngspice
    freerouting
    kicad-small
    jq
    zip
    unzip
  ];

  shellHook = ''
    if [ -L node_modules ] || [ ! -e node_modules ]; then
      ln -sfn "${nodeModules}/node_modules" node_modules
    fi
    export PATH="${tsci}/bin:${nodeModules}/node_modules/.bin:$PATH"
    export TSCI_TELEMETRY_DISABLED=1

    echo "[AgenticBoards] Shell ready: node $(node --version) | tsci | ngspice | kicad-cli | freerouting | biome"
    echo "  Commands: npm run dev | npm run verify | npm run export | npm run route"
  '';
}
