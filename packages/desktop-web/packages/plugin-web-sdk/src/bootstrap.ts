// FILE: bootstrap.ts
// Purpose: The JavaScript the host injects into every sandboxed plugin view before the plugin's
//          own HTML runs. It is plain ES5 so it needs no build step and cannot depend on host code.
//          `__NEOLIX_SESSION__` is replaced with a JSON string literal by the host.
// Layer: Plugin web SDK
// Exports: PLUGIN_WEB_SDK_SOURCE

export const PLUGIN_WEB_SDK_SESSION_MARKER = "__NEOLIX_SESSION__";

export const PLUGIN_WEB_SDK_SOURCE = String.raw`(function () {
  "use strict";
  var SESSION = __NEOLIX_SESSION__;
  var parentWindow = window.parent;
  var pending = new Map();
  var readyListeners = [];
  var themeListeners = [];
  var context = null;
  var sequence = 0;

  function post(message) {
    message.__neolix = true;
    message.session = SESSION;
    parentWindow.postMessage(message, "*");
  }

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      sequence += 1;
      var id = "r" + sequence;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ type: "request", id: id, method: method, params: params });
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || data.__neolix !== true || data.session !== SESSION) return;
    if (data.type === "response") {
      var entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error || "Plugin request failed"));
      return;
    }
    if (data.type === "init") {
      context = data.context;
      for (var i = 0; i < readyListeners.length; i += 1) {
        try { readyListeners[i](context); } catch (error) { console.error(error); }
      }
      return;
    }
    if (data.type === "theme") {
      var info = { theme: data.theme, variables: data.variables };
      for (var j = 0; j < themeListeners.length; j += 1) {
        try { themeListeners[j](info); } catch (error) { console.error(error); }
      }
    }
  });

  var api = {
    ready: function () { post({ type: "ready" }); },
    getContext: function () { return request("context.get"); },
    onReady: function (listener) {
      readyListeners.push(listener);
      if (context) listener(context);
      return function () {
        var index = readyListeners.indexOf(listener);
        if (index >= 0) readyListeners.splice(index, 1);
      };
    },
    rpc: {
      invoke: function (method, params) {
        return request("rpc.invoke", { method: method, params: params });
      }
    },
    navigate: {
      openView: function (viewId, params) {
        return request("navigate.openView", { view: viewId, params: params || {} });
      }
    },
    setHeight: function (height) { post({ type: "resize", height: height }); },
    onTheme: function (listener) {
      themeListeners.push(listener);
      return function () {
        var index = themeListeners.indexOf(listener);
        if (index >= 0) themeListeners.splice(index, 1);
      };
    }
  };

  Object.defineProperty(window, "neolix", {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true
  });
  post({ type: "ready" });
})();`;
