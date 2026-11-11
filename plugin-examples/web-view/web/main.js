(function () {
  var output = document.getElementById("output");
  var tall = false;
  function show(value) {
    output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  window.neolix.onReady(function (context) {
    show(
      "已连接\nview: " +
        context.viewId +
        "\npermissions: " +
        (context.permissions.join(", ") || "none") +
        "\nparams: " +
        JSON.stringify(context.params),
    );
  });
  window.neolix.onTheme(function (info) {
    document.documentElement.style.setProperty(
      "--fg",
      info.variables["--color-text-foreground"] || "#e6f7ff",
    );
    document.documentElement.style.setProperty(
      "--bg",
      info.variables["--color-surface-background"] || "#071a24",
    );
  });
  document.getElementById("greet").addEventListener("click", function () {
    window.neolix.rpc
      .invoke("greet", { name: "Web View" })
      .then(show)
      .catch(function (error) {
        show("RPC 失败：" + error.message);
      });
  });
  document.getElementById("navigate").addEventListener("click", function () {
    window.neolix.navigate
      .openView("main", { from: "iframe" })
      .then(() => show("已请求导航到 main"))
      .catch(function (error) {
        show("导航失败：" + error.message);
      });
  });
  document.getElementById("resize").addEventListener("click", function () {
    tall = !tall;
    window.neolix.setHeight(tall ? 560 : 260);
    show("请求高度：" + (tall ? 560 : 260));
  });
  window.neolix.setHeight(220);
})();
