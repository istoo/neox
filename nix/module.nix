{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.neolix;
in
{
  imports = [
    (lib.mkRenamedOptionModule [ "services" "neolix" "allowedHosts" ] [ "services" "neolix" "hostnames" ])
  ];

  options.services.neolix = {
    enable = lib.mkEnableOption "Neolix, a self-hosted daemon for AI coding agents";

    package = lib.mkPackageOption pkgs "neolix" { };

    user = lib.mkOption {
      type = lib.types.str;
      default = "neolix";
      description = "User account under which Neolix runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "neolix";
      description = "Group under which Neolix runs.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default =
        if cfg.user == "neolix"
        then "/var/lib/neolix"
        else "/home/${cfg.user}/.neox";
      defaultText = lib.literalExpression ''
        if cfg.user == "neolix"
        then "/var/lib/neolix"
        else "/home/''${cfg.user}/.neox"
      '';
      description = "Directory for Neolix state (NEOLIX_HOME). Stores agent data, config, and logs.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 6868;
      description = "Port for the Neolix daemon to listen on.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address for the Neolix daemon to bind to.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the firewall for the Neolix daemon port.";
    };

    hostnames = lib.mkOption {
      type = lib.types.either (lib.types.enum [ true ]) (lib.types.listOf lib.types.str);
      default = [ ];
      example = [ ".example.com" "myhost.local" ];
      description = ''
        Hostnames the Neolix daemon accepts in the Host header (DNS rebinding protection).
        Localhost and IP addresses are always allowed by default.

        Use a leading dot to match a domain and all its subdomains
        (e.g. `".example.com"` matches `example.com` and `foo.example.com`).

        Set to `true` to allow any host (not recommended).
      '';
    };

    relay = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Whether to enable relay-based remote access. When false, the daemon
          runs with `--no-relay` and only accepts direct (LAN/loopback)
          connections. There is no hosted relay: enabling this requires
          `relay.host` for a relay you deploy yourself.
        '';
      };

      mode = lib.mkOption {
        type = lib.types.enum [ "remote" ];
        default = "remote";
        description = ''
          How the daemon reaches the relay when `relay.enable = true`:
          connect to a self-hosted relay at `relay.host:relay.port`. Sets
          `NEOLIX_RELAY_ENDPOINT` and `NEOLIX_RELAY_USE_TLS` for the daemon.

          A `"local"` mode (running a relay on the same host as a systemd
          unit) is not yet implemented — the relay package currently only
          ships a Cloudflare Workers adapter. Tracked separately.
        '';
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "relay.example.com";
        description = "Relay hostname. Required when `relay.mode = \"remote\"`.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "Relay port. Used when `relay.mode = \"remote\"`.";
      };

      useTls = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether to use TLS when connecting to the relay. Used when `relay.mode = \"remote\"`.";
      };

      publicUseTls = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = ''
          Whether the public (client-facing) relay endpoint uses TLS.
          When `null` (default), the daemon falls back to `relay.useTls`.
          Override when the internal path is plain `ws://` behind a
          TLS-terminating reverse proxy.
        '';
      };
    };

    inheritUserEnvironment = lib.mkOption {
      type = lib.types.bool;
      default = cfg.user != "neolix";
      defaultText = lib.literalExpression ''cfg.user != "neolix"'';
      description = ''
        Whether to include the user's profile PATH in the service environment.

        When Neolix runs as a real user (not the default system user), AI agents
        need access to the user's tools (git, ssh, etc.). This adds the user's
        NixOS profile, home-manager profile (`~/.nix-profile/bin` and
        `~/.local/state/nix/profile/bin`), and system paths so agents can use
        them without manually setting PATH.

        Enabled by default when `user` is set to a non-default value.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''
        {
          NEOLIX_RELAY_ENDPOINT = "relay.example.com:443";
        }
      '';
      description = "Extra environment variables for the Neolix daemon.";
    };

    settings = lib.mkOption {
      type = (pkgs.formats.json { }).type;
      default = { };
      example = lib.literalExpression ''
        {
          daemon.mcp = { enabled = true; injectIntoAgents = false; };
          agents.providers.myAcp = {
            extends = "acp";
            label = "My Agent";
            command = { path = "/run/current-system/sw/bin/my-acp"; };
          };
          log.file = { level = "info"; path = "/var/lib/neolix/daemon.log"; };
        }
      '';
      description = ''
        Declarative content for `$NEOLIX_HOME/config.json`. Rendered to JSON
        and installed on every service start.

        Runtime mutations to `config.json` (e.g. via `neolix daemon set-password`
        or the mobile app toggling MCP injection / provider overrides) are
        overwritten on the next restart. Pick one: manage via this option, or
        manage via the CLI — not both.

        The full schema is defined by `PersistedConfigSchema` in
        `packages/server/src/server/persisted-config.ts`.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    let
      settingsFile = (pkgs.formats.json { }).generate "neolix-config.json" cfg.settings;
    in
    {
    assertions = [
      {
        assertion = !(cfg.relay.enable && cfg.relay.mode == "remote" && cfg.relay.host == "");
        message = ''
          services.neolix.relay.host must be set when relay.mode = "remote".
        '';
      }
    ];

    users.users.${cfg.user} = lib.mkIf (cfg.user == "neolix") {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
    };

    users.groups.${cfg.group} = lib.mkIf (cfg.group == "neolix") { };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 ${cfg.user} ${cfg.group} - -"
    ];

    systemd.services.neolix = {
      description = "Neolix - self-hosted daemon for AI coding agents";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];

      preStart = lib.mkIf (cfg.settings != { }) ''
        install -m 0600 ${settingsFile} ${cfg.dataDir}/config.json
      '';

      environment = {
        NEOLIX_HOME = cfg.dataDir;
        NEOLIX_LISTEN = "${cfg.listenAddress}:${toString cfg.port}";
      } // lib.optionalAttrs cfg.inheritUserEnvironment (
        let
          # Match dataDir's convention. We can't read users.users.<name>.home
          # because the user may be managed outside NixOS.
          userHome = "/home/${cfg.user}";
        in {
          # mkForce overrides the default PATH from NixOS's systemd module (which
          # only includes store paths for coreutils/grep/sed/systemd). When the
          # daemon runs as a real user, also include home-manager profile paths
          # so user-installed CLIs (claude, opencode, codex, ...) are reachable
          # by agent processes the daemon spawns.
          PATH = lib.mkForce (lib.concatStringsSep ":" (
            lib.optionals (cfg.user != "neolix") [
              "${userHome}/.nix-profile/bin"
              "${userHome}/.local/state/nix/profile/bin"
            ]
            ++ [
              "/etc/profiles/per-user/${cfg.user}/bin"
              "/run/current-system/sw/bin"
              "/run/wrappers/bin"
              "/nix/var/nix/profiles/default/bin"
            ]
          ));
        }
      ) // lib.optionalAttrs (cfg.hostnames == true) {
        NEOLIX_HOSTNAMES = "true";
      } // lib.optionalAttrs (lib.isList cfg.hostnames && cfg.hostnames != [ ]) {
        NEOLIX_HOSTNAMES = lib.concatStringsSep "," cfg.hostnames;
      } // lib.optionalAttrs (cfg.relay.enable && cfg.relay.mode == "remote") {
        NEOLIX_RELAY_ENDPOINT = "${cfg.relay.host}:${toString cfg.relay.port}";
        NEOLIX_RELAY_USE_TLS = if cfg.relay.useTls then "true" else "false";
      } // lib.optionalAttrs (cfg.relay.enable && cfg.relay.mode == "remote" && cfg.relay.publicUseTls != null) {
        NEOLIX_RELAY_PUBLIC_USE_TLS = if cfg.relay.publicUseTls then "true" else "false";
      } // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;

        ExecStart =
          "${cfg.package}/bin/neolix-server"
          + lib.optionalString (!cfg.relay.enable) " --no-relay";

        Restart = "on-failure";
        RestartSec = 5;

        # Graceful shutdown (server handles SIGTERM with a 10s timeout)
        KillSignal = "SIGTERM";
        TimeoutStopSec = 15;
      };
    };

    environment.systemPackages = [ cfg.package ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
    }
  );
}
