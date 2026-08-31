# Nix runtime package

This manifest gives `buildNpmPackage` a workspace-free production lockfile. The Nix build copies the extension sources into this package before installation. Development uses the root workspace and lockfile.
