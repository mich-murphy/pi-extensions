{
  description = "pi-extensions development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  # Official Rust binaries, pinned independently of nixpkgs.
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay/d3fe74269f2a6652437e21e78eb7e83be81f6982";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    rust-overlay,
    ...
  }: let
    systems = ["aarch64-darwin" "aarch64-linux" "x86_64-linux"];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    rustVersion = "1.98.0";
    gatewayMetadata = builtins.fromTOML (builtins.readFile ./packages/pi-comms/gateway/Cargo.toml);
    toolchainFor = pkgs: (pkgs.extend (import rust-overlay)).rust-bin.stable.${rustVersion}.minimal;
    gatewayChannel = (builtins.fromTOML (builtins.readFile ./packages/pi-comms/gateway/rust-toolchain.toml)).toolchain.channel;
  in {
    packages = forAllSystems (pkgs: let
      rustPlatform = pkgs.makeRustPlatform {
        cargo = toolchainFor pkgs;
        rustc = toolchainFor pkgs;
      };
      gateway = assert pkgs.lib.assertMsg (rustVersion == gatewayChannel)
      "gateway Rust toolchain must match the pinned flake toolchain";
        rustPlatform.buildRustPackage {
          pname = gatewayMetadata.package.name;
          version = gatewayMetadata.package.version;
          src = pkgs.lib.cleanSourceWith {
            src = ./packages/pi-comms/gateway;
            filter = path: type: !(builtins.elem (baseNameOf path) ["target" "release"]);
          };
          cargoLock.lockFile = ./packages/pi-comms/gateway/Cargo.lock;
          cargoBuildFlags = ["--bin" "pi-gateway"];
          # The repository Rust gate owns the full test matrix. This derivation
          # builds the executable without running native property tests.
          doCheck = false;
          meta.mainProgram = "pi-gateway";
        };
    in {
      pi-gateway = gateway;
      default = gateway;
    });

    apps = forAllSystems (pkgs: let
      package = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-gateway;
    in {
      pi-gateway = {
        type = "app";
        program = "${package}/bin/pi-gateway";
      };
      default = self.apps.${pkgs.stdenv.hostPlatform.system}.pi-gateway;
    });

    devShells = forAllSystems (pkgs: let
      rustToolchain = (pkgs.extend (import rust-overlay)).rust-bin.stable.${rustVersion}.minimal.override {
        extensions = ["clippy" "rustfmt"];
      };
    in {
      # mkShell includes a C compiler for the gateway build. Hegel's native
      # engine ships as an npm platform package and needs nothing from Nix.
      default = assert pkgs.lib.assertMsg (rustVersion == gatewayChannel)
      "flake.nix rustVersion (${rustVersion}) must equal channel in packages/pi-comms/gateway/rust-toolchain.toml (${gatewayChannel})";
        pkgs.mkShell {
          packages = [
            pkgs.nodejs_26
            rustToolchain
            pkgs.git
          ];
          CARGO_BUILD_JOBS = "2";
          RUST_TEST_THREADS = "2";
        };
    });

    formatter = forAllSystems (pkgs: pkgs.alejandra);
  };
}
