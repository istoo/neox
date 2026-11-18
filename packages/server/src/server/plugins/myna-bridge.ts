/**
 * The page side of myna's window bridge, served as a plugin web asset beside a converted page.
 *
 * myna's host answers the page directly. Neolix's host is behind a sandboxed frame, so this
 * script answers the same API on top of `window.neolix` and plugin RPC:
 *
 * - `ready`/`theme`/`onTheme` come from the frame's context and theme messages.
 * - `options.get`/`options.set` call the generated plugin's `settings.options.*` RPCs.
 * - `read` calls the generated `myna.read` RPC, which enforces `magpie.permissions`.
 * - `onAction` receives the action a provider or agent row opened the page with.
 *
 * myna renamed the global from `myna` to `owl` between the version this converter targeted and
 * current checkouts, so both names point at one API and both CSS variable prefixes are painted.
 *
 * Keep this module free of imports: the web test loads it in a real browser frame.
 */
export const MYNA_BRIDGE_SOURCE = String.raw`(function () {
  "use strict";
  var sdk = window.neolix && typeof window.neolix === "object" ? window.neolix : null;
  var themed = [];
  var watched = [];
  var acting = null;
  var acted = [];
  var context = null;
  var palette = {};
  var language = "en";
  var dark = false;
  var resolveReady;
  var ready = new Promise(function (resolve) { resolveReady = resolve; });

  function invoke(method, params) {
    if (!sdk || !sdk.rpc || typeof sdk.rpc.invoke !== "function") {
      return Promise.reject(new Error("This page is not running in a Neox plugin host"));
    }
    return sdk.rpc.invoke(method, params);
  }

  function optionsState() {
    return invoke("settings.options.read", {});
  }

  function optionsObject(state) {
    if (state && state.status === "ready") return state.values || {};
    var problem = state && state.error ? state.error : "The plugin's options are invalid";
    throw new Error(problem);
  }

  function saveOptions(values, attempts) {
    return optionsState().then(function (state) {
      optionsObject(state);
      return invoke("settings.options.write", {
        revision: state.revision,
        values: values
      }).then(function (saved) {
        if (saved && saved.status === "saved") return saved.values || values;
        if (saved && saved.status === "conflict" && attempts > 0) {
          return saveOptions(values, attempts - 1);
        }
        throw new Error(saved && saved.error ? saved.error : "Saving the plugin's options failed");
      });
    });
  }

  function targetOf(params) {
    if (params.providerId) {
      return { provider: { id: params.providerId, name: params.providerName || params.providerId } };
    }
    if (params.agentId) {
      return { agent: { id: params.agentId, name: params.agentName || params.agentId } };
    }
    return {};
  }

  function actionOf(params) {
    if (!params.action) return null;
    var action = { id: params.action };
    var target = targetOf(params);
    if (target.provider) action.provider = target.provider;
    if (target.agent) action.agent = target.agent;
    return action;
  }

  function theme() {
    return { dark: dark, lang: language, tokens: palette };
  }

  function paint() {
    var root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    root.lang = language;
    for (var key in palette) {
      if (!Object.prototype.hasOwnProperty.call(palette, key)) continue;
      root.style.setProperty("--myna-" + key, palette[key]);
      root.style.setProperty("--owl-" + key, palette[key]);
    }
  }

  function paletteOf(variables) {
    var source = variables || {};
    var mapped = {};
    var names = {
      bg: "--color-background",
      fg: "--color-foreground",
      "fg-2": "--color-muted-foreground",
      muted: "--color-muted-foreground",
      card: "--color-card",
      line: "--color-border",
      accent: "--color-accent-foreground",
      "accent-soft": "--color-secondary",
      "accent-fg": "--color-accent-foreground"
    };
    for (var key in names) {
      if (!Object.prototype.hasOwnProperty.call(names, key)) continue;
      var value = source[names[key]];
      if (typeof value === "string" && value !== "") mapped[key] = value;
    }
    return mapped;
  }

  function act(data) {
    try {
      Promise.resolve(acting(data)).catch(report);
    } catch (error) {
      report(error);
    }
  }

  function report(error) {
    if (window.console && typeof window.console.error === "function") {
      window.console.error(error);
    }
  }

  function applyContext(next) {
    context = next && typeof next === "object" ? next : {};
    dark = context.theme === "dark";
    language = typeof context.locale === "string" && context.locale ? context.locale : "en";
    api.context = targetOf(context.params || {});
    api.theme = theme();
    paint();
    resolveReady(api.theme);
    var action = actionOf(context.params || {});
    if (action) {
      if (acting) act(action);
      else acted.push(action);
    }
  }

  var api = {
    theme: null,
    context: {},
    service: "",
    visible: true,
    onTheme: function (listener) {
      themed.push(listener);
    },
    onVisibility: function (listener) {
      watched.push(listener);
    },
    onAction: function (listener) {
      acting = listener;
      var waiting = acted.splice(0);
      for (var i = 0; i < waiting.length; i += 1) act(waiting[i]);
    },
    options: {
      get: function () {
        return optionsState().then(optionsObject);
      },
      set: function (options) {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          return Promise.reject(new Error("A page's options are an object"));
        }
        return saveOptions(options, 1);
      }
    },
    read: function (name, params) {
      return invoke("myna.read", { name: name, params: params || {} });
    }
  };
  api.ready = ready;

  if (sdk) {
    if (typeof sdk.onReady === "function") sdk.onReady(applyContext);
    if (typeof sdk.onTheme === "function") {
      sdk.onTheme(function (info) {
        dark = info && info.theme === "dark";
        palette = paletteOf(info && info.variables);
        api.theme = theme();
        paint();
        var current = api.theme;
        for (var i = 0; i < themed.length; i += 1) {
          try {
            themed[i](current);
          } catch (error) {
            report(error);
          }
        }
      });
    } else {
      applyContext(null);
    }
  } else {
    applyContext(null);
  }

  window.myna = api;
  window.owl = api;
})();`;
