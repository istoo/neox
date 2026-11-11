/**
 * `/me` is the page a gateway key's holder opens to see their own limits and
 * usage. It asks for the key, sends it once to `/v1/myna/me`, and renders the
 * reply; the key is never put in the address and never leaves this page.
 */
export const KEY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway key</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 32px; background: #0f1117; color: #e6e8ee; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: #98a1b3; margin: 0 0 24px; }
  form { display: flex; gap: 8px; margin-bottom: 24px; }
  input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2f3a; background: #161922; color: inherit; font: inherit; }
  button { padding: 10px 16px; border-radius: 8px; border: 0; background: #4f46e5; color: white; font: inherit; font-weight: 600; cursor: pointer; }
  section { background: #161922; border: 1px solid #2a2f3a; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #98a1b3; margin: 0 0 12px; }
  dl { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0; }
  dt { color: #98a1b3; }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 0; border-bottom: 1px solid #232833; font-size: 14px; }
  th { color: #98a1b3; font-weight: 500; }
  .error { color: #f87171; }
</style>
</head>
<body>
<main>
  <h1>Gateway key</h1>
  <p class="sub">Enter the key you were given. It stays in this page and is sent only to this daemon.</p>
  <form id="f">
    <input id="k" type="password" autocomplete="off" placeholder="pk_… or your gateway key" aria-label="Gateway key">
    <button type="submit">Show</button>
  </form>
  <div id="out"></div>
</main>
<script>
const out = document.getElementById("out");
document.getElementById("f").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = document.getElementById("k").value.trim();
  if (!key) return;
  out.innerHTML = "";
  try {
    const response = await fetch("/v1/myna/me", { headers: { authorization: "Bearer " + key } });
    const body = await response.json();
    if (!response.ok) {
      out.innerHTML = '<section><p class="error">' + (body.error && body.error.message ? body.error.message : "Refused") + "</p></section>";
      return;
    }
    render(body);
  } catch (error) {
    out.innerHTML = '<section><p class="error">' + String(error) + "</p></section>";
  }
});
function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}
function render(body) {
  const limit = (name, value) => "<dt>" + esc(name) + "</dt><dd>" + (value === null || value === undefined ? "none" : esc(value)) + "</dd>";
  let html = "<section><h2>Key</h2><dl>" +
    limit("Label", body.label || "unnamed") +
    limit("Read-only", body.readOnly ? "yes" : "no") +
    limit("Models", body.models && body.models.length ? body.models.join(", ") : "every model") +
    limit("Daily tokens", body.dailyTokens) +
    limit("Monthly spend", body.monthlyUsd === null ? null : "$" + body.monthlyUsd) +
    limit("Requests per minute", body.ratePerMinute) +
    limit("Search calls per month", body.searchCallsPerMonth) +
    limit("Spent this month", "$" + Number(body.spentThisMonthUsd || 0).toFixed(2)) +
    limit("Tokens today", body.tokensToday) +
    "</dl></section>";
  const recent = body.recent || [];
  html += "<section><h2>Recent calls</h2>";
  if (recent.length === 0) {
    html += "<p>No calls yet.</p>";
  } else {
    html += "<table><thead><tr><th>Time</th><th>Model</th><th>Status</th><th>Tokens</th></tr></thead><tbody>";
    for (const entry of recent.slice(0, 20)) {
      html += "<tr><td>" + esc(entry.time) + "</td><td>" + esc(entry.requested || entry.model) + "</td><td>" + esc(entry.status) + "</td><td>" + esc((entry.inputTokens || 0) + (entry.outputTokens || 0)) + "</td></tr>";
    }
    html += "</tbody></table>";
  }
  html += "</section>";
  out.innerHTML = html;
}
</script>
</body>
</html>`;
