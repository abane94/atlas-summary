{
  description = "Puppeteer scripts using system Chrome (no bundled browser)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
          ];

          shellHook = ''
            # Your existing Chrome — not installed by this flake
            export CHROME_PATH="/etc/profiles/per-user/aris/bin/google-chrome-stable"
            # Chrome 136+ ignores --remote-debugging-port on the default profile.
            # Seed logins with: npm run chrome:seed
            export CHROME_USER_DATA_DIR="$HOME/.config/google-chrome-automation"
            export CHROME_DEBUG_URL="http://127.0.0.1:9222"
            export PUPPETEER_MODE="connect"

            if [ ! -d node_modules ]; then
              echo "Run: npm install"
            fi
          '';
        };
      });
}
