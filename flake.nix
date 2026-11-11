{
  description = "Neolix - self-hosted daemon for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          neolix = pkgs.callPackage ./nix/package.nix { };
          versionParts = pkgs.lib.splitString "." neolix.version;
          sourceRevision = if self ? revCount && self.revCount != null then self.revCount else 0;
          buildRevision = sourceRevision - (sourceRevision / 10000) * 10000;
          desktopBuildVersion = pkgs.lib.concatStringsSep "." [
            (builtins.elemAt versionParts 0)
            (builtins.elemAt versionParts 1)
            (toString buildRevision)
          ];
        in
        {
          default = neolix;
          neolix = neolix;
          desktop = pkgs.callPackage ./nix/desktop-package.nix {
            inherit neolix;
            buildVersion = desktopBuildVersion;
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          packages = self.packages.${system};
          license = (builtins.fromJSON (builtins.readFile ./package.json)).license;
        in
        {
          license-metadata =
            assert packages.neolix.meta.license.spdxId == license;
            assert packages.desktop.meta.license.spdxId == license;
            pkgs.runCommand "neolix-license-metadata" { } "touch $out";
        }
      );

      nixosModules.default = self.nixosModules.neolix;
      nixosModules.neolix =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.neolix.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.python3
            ];
          };
        }
      );
    };
}
