set shell := ["bash", "-euo", "pipefail", "-c"]

# Show repository maintenance commands
default:
    @just --list

# Format all files in the repository (Nix, JS/TS/JSON, Markdown, Shell, justfile)
fmt:
    nix fmt

# Check formatting & linting across the repository
lint:
    nix flake check
