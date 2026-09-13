// Phase 37 — the dashboard itself. Deliberately NOT Grafana/Prometheus: a single static HTML
// page, served by this project's own existing Express app (httpApp.ts's `GET /dashboard`),
// polling `GET /v1/metrics` on a plain interval and rendering the result as a flat table. This is
// "whatever lightweight dashboard is practical given this is a solo/portfolio project" (this
// phase's own reference text) — no build step, no new dependency, no separate service to deploy
// or keep running; it works anywhere this server itself is reachable, phone browsers included,
// which is the one hard requirement. Real and live (a genuine `fetch()` against the real metrics
// endpoint, not a canned screenshot), not decorative.

export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Collab Editor — Ops Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 12px; background: #f5f5f7; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #e5e5e5; } .card { background: #2a2a2a !important; border-color: #3a3a3a !important; } th { color: #999 !important; } }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  .updated { font-size: 0.75rem; color: #888; margin-bottom: 12px; }
  .group { margin-bottom: 16px; }
  .group h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin: 0 0 6px; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #eee; white-space: nowrap; }
  th { font-weight: 500; color: #666; }
  td.value { text-align: right; font-variant-numeric: tabular-nums; }
  .alert { color: #c0392b; font-weight: 600; }
  .ok { color: #27ae60; }
  #err { color: #c0392b; font-size: 0.8rem; margin-top: 8px; }
</style>
</head>
<body>
<h1>Collab Editor — Ops Dashboard</h1>
<div class="updated" id="updated">loading…</div>
<div id="groups"></div>
<div id="err"></div>
<script>
// Metric name -> group, in the exact order/grouping the Runbook table specifies. Anything the
// server returns that isn't listed here still renders, under "Other" — the grouping is cosmetic,
// never a filter.
const GROUPS = [
  ["Convergence", ["audit.mismatch_count", "audit.minutes_since_last_successful_run"]],
  ["Connections", ["ws.active_connections", "ws.abnormal_disconnect_rate", "ws.connection_churn", "ws.upgrade_rejection_rate", "ws.handshake_incomplete"]],
  ["Latency", ["op.remote_visibility_p50", "op.remote_visibility_p95", "op.remote_visibility_p99", "op.server_apply_p95", "op.commit_latency_p95", "presence.latency_p95"]],
  ["Reconnection", ["reconcile.duration_p95", "reconcile.catchup_ops_p95", "reconcile.resend_ops_p95", "reconcile.already_have_ratio", "reconcile.failure_rate", "reconcile.offline_window_exceeded_count"]],
  ["Queues", ["queue.ops_depth", "queue.presence_depth", "presence.shed_count"]],
  ["GC", ["gc.minutes_since_last_success", "gc.cycle_duration_p95", "gc.nodes_collected_per_cycle", "gc.frontier_lag_seconds"]],
  ["Documents", ["doc.structure_size", "doc.tombstone_ratio", "engine.replica_bytes_p95"]],
  ["Authz", ["authz.op_rejected_count", "authz.identity_mismatch_count", "authz.revocation_effect_p95", "authz.cache_age_max"]],
  ["Client (RUM beacon)", ["binding.reconciliation", "binding.desync_error", "binding.composition_watchdog_fired", "binding.indexeddb_unavailable", "client.local_echo_p50", "client.local_echo_p95", "client.local_echo_p99"]],
];

// Two metrics whose LIVENESS matters more than their value — highlighted red once stale, per
// this phase's own required comments in gcScheduler.ts/auditScheduler.ts.
function isAlert(name, value) {
  if (name === "gc.minutes_since_last_success" && typeof value === "number" && value > 10) return true;
  if (name === "audit.minutes_since_last_successful_run" && typeof value === "number" && value > 15) return true;
  if (name === "audit.mismatch_count" && typeof value === "number" && value > 0) return true;
  return false;
}

function fmt(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

async function refresh() {
  try {
    const res = await fetch("/v1/metrics", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    document.getElementById("err").textContent = "";
    document.getElementById("updated").textContent = "Updated " + new Date().toLocaleTimeString();
    const seen = new Set();
    const container = document.getElementById("groups");
    container.innerHTML = "";
    for (const [label, names] of GROUPS) {
      const div = document.createElement("div");
      div.className = "group";
      const h2 = document.createElement("h2");
      h2.textContent = label;
      div.appendChild(h2);
      const card = document.createElement("div");
      card.className = "card";
      const table = document.createElement("table");
      for (const name of names) {
        seen.add(name);
        const value = data[name];
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = name;
        const td = document.createElement("td");
        td.className = "value" + (isAlert(name, value) ? " alert" : "");
        td.textContent = fmt(value);
        tr.appendChild(th);
        tr.appendChild(td);
        table.appendChild(tr);
      }
      card.appendChild(table);
      div.appendChild(card);
      container.appendChild(div);
    }
    const rest = Object.keys(data).filter((k) => !seen.has(k)).sort();
    if (rest.length > 0) {
      const div = document.createElement("div");
      div.className = "group";
      const h2 = document.createElement("h2");
      h2.textContent = "Other";
      div.appendChild(h2);
      const card = document.createElement("div");
      card.className = "card";
      const table = document.createElement("table");
      for (const name of rest) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = name;
        const td = document.createElement("td");
        td.className = "value";
        td.textContent = fmt(data[name]);
        tr.appendChild(th);
        tr.appendChild(td);
        table.appendChild(tr);
      }
      card.appendChild(table);
      div.appendChild(card);
      container.appendChild(div);
    }
  } catch (err) {
    document.getElementById("err").textContent = "Failed to load metrics: " + err;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
