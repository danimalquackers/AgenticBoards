{
  description = "PCB project powered by AgenticBoards (tscircuit, ngspice, KiCad CLI, Freerouting)";

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
          f { inherit pkgs treefmtEval; }
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

      devShells = forAllSystems (
        { pkgs, treefmtEval }:
        {
          default = import ./shell.nix {
            inherit pkgs;
            extraPackages = [ treefmtEval.config.build.wrapper ];
          };
        }
      );
    };
}
