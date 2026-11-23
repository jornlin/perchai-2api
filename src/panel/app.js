"use strict";
// Perch2API admin panel. No framework, no build step.

const $ = (sel) => document.querySelector(sel);
const state = { token: localStorage.getItem("perch_admin_token") || "", current: null, timer: null, data: null };

function api(path, opts = {}) {
  return fetch(`/admin/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.token}`,
      ...(opts.headers || {}),
    },
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { lock(); throw new Error("管理令牌无效"); }
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  });
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 2600);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtAgo(sec) {
  if (sec == null) return "—";
  const s = Math.round(sec);
  if (s <= 0) return "已过期";
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时`;
  return `${(s / 86400).toFixed(1)} 天`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtNum(n) {
  return n == null ? "—" : Number(n).toLocaleString("en-US");
}

// ---- gate ---------------------------------------------------------------
function lock() {
  state.token = "";
  localStorage.removeItem("perch_admin_token");
  clearInterval(state.timer);
  $("#app").classList.add("hidden");
  $("#gate").classList.remove("hidden");
}

async function unlock(token) {
  state.token = token;
  try {
    await api("/overview");
    localStorage.setItem("perch_admin_token", token);
    $("#gate").classList.add("hidden");
    $("#gate-err").textContent = "";
    $("#app").classList.remove("hidden");
    await load();
    await loadModels();
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 5000);
  } catch (e) {
    state.token = "";
    $("#gate-err").textContent = e.message;
  }
}

// ---- render -------------------------------------------------------------
function render(d) {
  state.data = d;
  $("#backend").textContent = d.backend;
  $("#uptime").textContent = `运行 ${fmtAgo(d.uptimeSec)}`;

  const k = d.kpis;
  const cards = [
    ["账号", k.accounts, ""],
    ["健康", k.healthy, "ok"],
    ["需处理", k.attention, k.attention ? "warn" : ""],
    ["请求", fmtNum(k.requests), ""],
    ["错误", fmtNum(k.errors), k.errors ? "bad" : ""],
    ["Tokens", fmtNum(k.tokens), ""],
    ["本月 PT", fmtNum(k.monthPt), k.monthPt ? "warn" : ""],
    ["本月花费", `$${(k.monthUsd || 0).toFixed(4)}`, ""],
  ];
  $("#kpis").innerHTML = cards.map(([label, v, cls]) =>
    `<div class="kpi"><div class="k">${label}</div><div class="v ${cls}">${v}</div></div>`).join("");

  const rows = d.accounts.map((a) => {
    let pill = `<span class="pill ok">正常</span>`;
    if (!a.enabled) pill = `<span class="pill mute">已停用</span>`;
    else if (!a.configured) pill = `<span class="pill warn">未登录</span>`;
    else if (a.planRequired === true) pill = `<span class="pill warn">未激活套餐</span>`;
    else if (a.expiresInSec != null && a.expiresInSec <= 0) pill = `<span class="pill bad">令牌过期</span>`;
    else if (a.lastStatus >= 400) pill = `<span class="pill bad">最近报错</span>`;

    const plan = a.planRequired == null ? `<span class="muted">—</span>`
      : a.planRequired ? `<span class="pill warn">需要选择</span>` : `<span class="pill ok">已就绪</span>`;

    const exp = a.expiresInSec == null ? `<span class="muted">—</span>`
      : a.expiresInSec <= 0 ? `<span class="pill bad">已过期</span>`
      : `<span class="mono">${fmtAgo(a.expiresInSec)}</span>`;

    const ops = [
      `<button class="btn sm" data-act="login" data-name="${esc(a.name)}">${a.configured ? "重新登录" : "登录"}</button>`,
      a.configured ? `<button class="btn sm" data-act="refresh" data-name="${esc(a.name)}">刷新令牌</button>` : "",
      `<button class="btn sm" data-act="reveal" data-name="${esc(a.name)}">复制 Key</button>`,
      `<button class="btn sm" data-act="toggle" data-name="${esc(a.name)}" data-enabled="${a.enabled}">${a.enabled ? "停用" : "启用"}</button>`,
      `<button class="btn sm danger" data-act="remove" data-name="${esc(a.name)}">删除</button>`,
    ].filter(Boolean).join(" ");

    return `<tr>
      <td>${pill}</td>
      <td><strong>${esc(a.name)}</strong></td>
      <td>${a.email ? esc(a.email) : `<span class="muted">—</span>`}</td>
      <td>${plan}</td>
      <td>${exp}</td>
      <td class="n mono" data-act="allowance" data-name="${esc(a.name)}" title="点击修改额度 · 剩余 ${fmtNum(a.remainingPt)} PT" style="cursor:pointer">${fmtNum(a.spentPt)} / ${fmtNum(a.allowancePt)}</td>
      <td class="n mono">${a.activeRequests}${a.queued ? ` / ${a.queued}q` : ""}</td>
      <td class="n mono">${fmtNum(a.requests)}</td>
      <td class="n mono">${a.errors ? `<span style="color:var(--bad)">${fmtNum(a.errors)}</span>` : "0"}</td>
      <td class="mono muted">${esc(a.keyMasked)}</td>
      <td>${ops}</td>
    </tr>`;
  });
  $("#acc-body").innerHTML = rows.join("");
  $("#acc-empty").classList.toggle("hidden", rows.length > 0);

  const logs = d.logs || [];
  $("#log-count").textContent = logs.length ? `最近 ${logs.length} 条` : "";
  $("#log-body").innerHTML = logs.map((l) => {
    const cls = l.status >= 500 ? "bad" : l.status >= 400 ? "warn" : "ok";
    return `<tr>
      <td class="mono muted">${new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })}</td>
      <td>${esc(l.account || "—")}</td>
      <td class="mono">${esc(l.model || "—")}</td>
      <td class="n"><span class="pill ${cls}">${l.status ?? "—"}</span></td>
      <td class="n mono">${l.ms != null ? `${l.ms}ms` : "—"}</td>
      <td class="n mono">${fmtNum(l.tokens)}</td>
      <td class="n mono">${l.costUsd != null ? (l.costUsd * 1000).toFixed(2) : "—"}</td>
    </tr>`;
  }).join("");
  $("#log-empty").classList.toggle("hidden", logs.length > 0);
}

async function load() {
  const d = await api("/overview");
  render(d);
  renderTestAccounts(d.accounts);
}

function renderTestAccounts(accounts) {
  const sel = $("#test-account");
  const prev = sel.value;
  sel.innerHTML = accounts.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}${a.email ? ` · ${esc(a.email)}` : ""}</option>`).join("");
  if (accounts.some((a) => a.name === prev)) sel.value = prev;
}

async function loadModels() {
  try {
    const r = await api("/models");
    state.models = r.models || [];
    $("#model-count").textContent = state.models.length ? `${state.models.length} 个` : "";
    $("#models").innerHTML = state.models.map((m) => `<button class="chip" data-model="${esc(m)}">${esc(m)}</button>`).join("");
    $("#test-model").innerHTML = state.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  } catch (e) {
    $("#models").innerHTML = `<span class="muted">加载失败：${esc(e.message)}</span>`;
  }
}

async function runTest() {
  const btn = $("#test-go");
  const out = $("#test-out");
  btn.disabled = true;
  $("#test-meta").textContent = "请求中…（CLI 后端通常 10–20 秒）";
  out.classList.add("hidden");
  try {
    const r = await api("/test", {
      method: "POST",
      body: JSON.stringify({
        model: $("#test-model").value,
        account: $("#test-account").value,
        prompt: $("#test-prompt").value,
      }),
    });
    const cost = r.costUsd != null ? ` · $${r.costUsd.toFixed(5)}（${(r.costUsd * 1000).toFixed(2)} PT）` : "";
    $("#test-meta").textContent = `${r.ok ? "成功" : "失败"} · HTTP ${r.status} · ${r.ms}ms · ${r.model || ""}${r.usage ? ` · ${r.usage.total_tokens} tokens` : ""}${cost}`;
    out.textContent = r.ok ? r.content : `错误：${r.error || "未知错误"}`;
    out.classList.toggle("bad", !r.ok);
    out.classList.remove("hidden");
    return load();
  } catch (e) {
    $("#test-meta").textContent = "";
    out.textContent = e.message;
    out.classList.add("bad");
    out.classList.remove("hidden");
  } finally {
    btn.disabled = false;
  }
}

// ---- actions ------------------------------------------------------------
async function onTableClick(ev) {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const { act, name, enabled } = btn.dataset;
  try {
    if (act === "allowance") {
      const cur = (state.data?.accounts || []).find((x) => x.name === name)?.allowancePt ?? 20000;
      const v = prompt(`设置 ${name} 的每月额度（PT，1 PT = $0.001）`, String(cur));
      if (v == null) return;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return toast("额度必须是非负数字");
      await api(`/accounts/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ allowancePt: n }) });
      return load();
    }
    if (act === "login") return openLogin(name);
    if (act === "refresh") {
      btn.disabled = true;
      await api(`/accounts/${encodeURIComponent(name)}/refresh`, { method: "POST" });
      toast("令牌已刷新");
      return load();
    }
    if (act === "reveal") {
      const r = await api(`/accounts/${encodeURIComponent(name)}/reveal`, { method: "POST" });
      await navigator.clipboard.writeText(r.key).catch(() => {});
      toast(`已复制：${r.key}`);
      return;
    }
    if (act === "toggle") {
      await api(`/accounts/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ enabled: enabled !== "true" }) });
      return load();
    }
    if (act === "remove") {
      if (!confirm(`删除账号 ${name}？会话文件会一起删掉。`)) return;
      await api(`/accounts/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast("已删除");
      return load();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---- login modal --------------------------------------------------------
function openLogin(name) {
  state.current = name;
  $("#modal-title").textContent = `登录账号 · ${name}`;
  $("#login-url").value = "";
  $("#callback").value = "";
  $("#login-err").textContent = "";
  $("#modal").classList.remove("hidden");
}

async function startLogin() {
  if (!state.current) return;
  const provider = $("#login-provider").value;
  try {
    $("#login-err").textContent = "";
    const r = await api(`/accounts/${encodeURIComponent(state.current)}/login`, {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    $("#login-url").value = r.url;
    await navigator.clipboard.writeText(r.url).catch(() => {});
    window.open(r.url, "_blank", "noopener");
    toast("登录链接已复制并打开");
  } catch (e) {
    $("#login-err").textContent = e.message;
  }
}

async function finishLogin() {
  if (!state.current) return;
  try {
    $("#login-err").textContent = "";
    const redirect = $("#callback").value.trim();
    if (!redirect) throw new Error("请先粘贴回调地址");
    const r = await api(`/accounts/${encodeURIComponent(state.current)}/login-finish`, {
      method: "POST",
      body: JSON.stringify({ redirect }),
    });
    toast(`已登录：${r.account?.email || state.current}`);
    closeModal();
    return load();
  } catch (e) {
    $("#login-err").textContent = e.message;
  }
}

function closeModal() {
  $("#modal").classList.add("hidden");
  state.current = null;
}

// ---- wiring -------------------------------------------------------------
$("#gate-go").addEventListener("click", () => unlock($("#gate-token").value.trim()));
$("#gate-token").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock($("#gate-token").value.trim()); });
$("#logout").addEventListener("click", lock);
$("#refresh").addEventListener("click", () => load().then(() => toast("已刷新")).catch((e) => toast(e.message)));
$("#acc-body").addEventListener("click", onTableClick);
$("#models").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $("#test-model").value = chip.dataset.model;
  document.querySelectorAll("#models .chip").forEach((c) => c.classList.toggle("on", c === chip));
});
$("#test-model").addEventListener("change", () => {
  document.querySelectorAll("#models .chip").forEach((c) => c.classList.toggle("on", c.dataset.model === $("#test-model").value));
});
$("#test-go").addEventListener("click", runTest);
$("#modal-close").addEventListener("click", closeModal);
$("#open-login").addEventListener("click", startLogin);
$("#finish-login").addEventListener("click", finishLogin);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

$("#add-account").addEventListener("click", async () => {
  const input = $("#new-name");
  const name = input.value.trim();
  if (!name) return toast("先填账号名");
  try {
    const r = await api("/accounts", { method: "POST", body: JSON.stringify({ name }) });
    input.value = "";
    toast(`已创建 ${r.account.name}，Key：${r.account.keyMasked}`);
    await load();
    openLogin(name);
  } catch (e) {
    toast(e.message);
  }
});

if (state.token) unlock(state.token);
else lock();
