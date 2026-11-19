{
  description = "AgenticBoards — Declarative Nix + TDD agentic PCB design workbench";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in
    {
      devShells = forAllSystems (pkgs: {
        default = import ./shell.nix { inherit pkgs; };
      });

      # Usable directly as a Nix flake template:
      #   nix flake new my-pcb -t github:<owner>/AgenticBoards
      templates.default = {
        path = ./.;
        description = "TDD agentic PCB starter (tscircuit, ngspice, KiCad CLI, Freerouting)";
        welcomeText = ''
          AgenticBoards initialized!
          1. Run `direnv allow` (or `nix develop` / `nix-shell`)
          2. Run `npm run verify`
          3. Start Antigravity and prompt your agent with your PCB goals & constraints.
        '';
      };
    };
}
