# Declarative PCB development environment (no Bun, no manual `npm install`).
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
in
pkgs.mkShell {
  name = "agentic-boards";

  packages = with pkgs; [
    # Node.js 24 LTS runtime & Biome linter/formatter
    nodejs
    biome

    # Electrical simulation (SPICE)
    ngspice

    # External Specctra DSN/SES PCB autorouter
    freerouting

    # Independent KiCad ERC/DRC/export verification (provides kicad-cli & gerbview)
    kicad-small

    # Scripting & utilities for hooks, BOM, and thermal/impedance helpers
    jq
    python3
    zip
    unzip
  ];

  shellHook = ''
    # Symlink declarative /nix/store node_modules into workspace when absent or already a symlink
    if [ -L node_modules ] || [ ! -e node_modules ]; then
      ln -sfn "${nodeModules}/node_modules" node_modules
    fi
    export PATH="${nodeModules}/node_modules/.bin:$PATH"
    export TSCI_TELEMETRY_DISABLED=1

    echo "[AgenticBoards] Declarative PCB shell ready."
    echo "  Tools: node $(node --version) | tsci | ngspice | freerouting | kicad-cli | biome"
    echo "  Commands: npm run dev | npm run verify | npm run export | npm run route"
  '';
}
