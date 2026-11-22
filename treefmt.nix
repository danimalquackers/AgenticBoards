{ ... }:
let
  biomeConfig = builtins.removeAttrs (builtins.fromJSON (builtins.readFile ./biome.json)) [
    "$schema"
  ];
in
{
  projectRootFile = "flake.nix";

  programs = {
    biome = {
      enable = true;
      settings = biomeConfig;
    };
    nixfmt.enable = true;
    just.enable = true;
    shellcheck = {
      enable = true;
      excludes = [
        ".envrc"
        "**/.envrc"
      ];
    };
    shfmt.enable = true;
    prettier = {
      enable = true;
      includes = [
        "*.md"
        "*.yml"
        "*.yaml"
      ];
    };
  };

  settings = {
    global.excludes = [
      "package-lock.json"
      "template/package-lock.json"
      "flake.lock"
      "template/flake.lock"
      "**/dist/**"
      "**/node_modules/**"
      "**/.direnv/**"
    ];
    formatter = {
      shellcheck.priority = 1;
      shfmt.priority = 2;
    };
  };
}
