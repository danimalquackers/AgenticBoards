{
  description = "AgenticBoards — Scaffolder & TDD PCB workbench (tscircuit, ngspice, KiCad CLI, Freerouting)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          let
            pkgs = import nixpkgs { inherit system; };
            treefmtEval = treefmt-nix.lib.evalModule pkgs ./treefmt.nix;
          in
          f { inherit pkgs system treefmtEval; }
        );
    in
    {
      formatter = forAllSystems ({ treefmtEval, ... }: treefmtEval.config.build.wrapper);

      checks = forAllSystems (
        { treefmtEval, ... }:
        {
          formatting = treefmtEval.config.build.check self;
        }
      );

      packages = forAllSystems (
        { pkgs, ... }:
        let
          cliNodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./.;
            inherit (pkgs) nodejs;
          };
        in
        rec {
          create-agentic-board = pkgs.stdenvNoCC.mkDerivation {
            pname = "create-agentic-board";
            version = "0.1.0";
            src = ./.;

            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontBuild = true;
            installPhase = ''
              # bash

              mkdir -p $out/share/create-agentic-board $out/bin

              cp -r bin template package.json $out/share/create-agentic-board/
              ln -s "${cliNodeModules}/node_modules" $out/share/create-agentic-board/node_modules

              makeWrapper ${pkgs.lib.getExe pkgs.nodejs} $out/bin/create-agentic-board \
                --add-flags $out/share/create-agentic-board/bin/create-agentic-board.mjs \
                --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs ]}
            '';

            meta.mainProgram = "create-agentic-board";
          };
          default = create-agentic-board;
        }
      );

      apps = forAllSystems (
        { system, pkgs, ... }:
        {
          default = {
            type = "app";
            program = pkgs.lib.getExe' self.packages.${system}.create-agentic-board "create-agentic-board";
            meta.description = "Scaffold a TDD-driven, fab-ready PCB project";
          };
        }
      );

      devShells = forAllSystems (
        { pkgs, treefmtEval, ... }:
        {
          default = import ./template/shell.nix {
            inherit pkgs;
            extraPackages = [ treefmtEval.config.build.wrapper ];
          };
        }
      );

      templates.default = {
        path = ./template;
        description = "TDD agentic PCB starter (tscircuit, ngspice, KiCad CLI, Freerouting)";
        welcomeText = ''
          AgenticBoards initialized!
          1. Run `direnv allow` (or `nix develop` / `nix-shell`)
          2. Run `just verify`
          3. Open your AI coding agent and describe your PCB goals & constraints.
        '';
      };
    };
}
