// Adapted from myna's internal/gui/testdata/page-plugin.
// What myna's window gives a page: the theme, its own options, and the
// reads package.json's magpie.permissions declares.
(async () => {
  await window.owl.ready;
  const opts = await window.owl.options.get();
  const s = await window.owl.read("usage:summary", { period: "today" });
  document.getElementById("calls").textContent = `${s.calls} calls, ${s.input + s.output} tokens`;
  const cost = document.getElementById("cost");
  const paint = (hide) => {
    cost.textContent = hide ? "" : `$${s.cost.toFixed(2)}`;
  };
  paint(opts.hideCost);
  document.getElementById("hide").addEventListener("click", async () => {
    const next = await window.owl.options.set({ ...opts, hideCost: !opts.hideCost });
    Object.assign(opts, next);
    paint(opts.hideCost);
  });
})();
