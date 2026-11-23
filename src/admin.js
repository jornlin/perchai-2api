"use strict";
// Admin panel: account management, live status and request log for the gateway.
// Mounted at /admin (page) and /admin/api/* (JSON). Auth: bearer token.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { CLI_MODELS } = require("./cli");

const PANEL_DIR = path.join(__dirname, "panel");
const decoder = (buf) => buf.toString("utf8");

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function maskKey(key) {
  if (!key) return "";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function loadOrCreateAdminToken(dataDir) {
  const file = path.join(dataDir, "admin-token.txt");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {}
  const token = crypto.randomBytes(18).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

// Perch serves its auth API behind the app edge when the caller looks like the CLI.
async function authBase(cfg) {
  try {
    const res = await fetch(`${cfg.appUrl}/api/perch-terminal/cli-auth/config`, {
      headers: { Accept: "application/json", "User-Agent": cfg.userAgent },
      signal: AbortSignal.timeout(10_000),
    });
    const c = await res.json();
    if (c?.ok && c.supabaseUrl) return c.backend === "edge" ? `${cfg.appUrl}/data-edge` : c.supabaseUrl;
  } catch {}
  return "https://app.perchai.app/data-edge";
}

async function exchangePkce({ cfg, code, verifier }) {
  const base = await authBase(cfg);
  const keyRes = await fetch(`${cfg.appUrl}/api/perch-terminal/cli-auth/config`, {
    headers: { Accept: "application/json", "User-Agent": cfg.userAgent },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json()).catch(() => null);
  const apikey = keyRes?.supabaseAnonKey;
  if (!apikey) throw Object.assign(new Error("无法获取上游 auth 配置"), { status: 502 });
  const res = await fetch(`${base}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey, Authorization: `Bearer ${apikey}` },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    signal: AbortSignal.timeout(20_000),
  });
  const d = await res.json().catch(() => ({}));
  if (res.status !== 200 || !d?.access_token) {
    throw Object.assign(new Error(d?.msg || d?.error_description || d?.message || `认证失败 HTTP ${res.status}`), { status: 400 });
  }
  return {
    version: 1,
    appUrl: cfg.appUrl,
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? null,
    expiresAt: d.expires_at ?? (d.expires_in ? Math.floor(Date.now() / 1000) + d.expires_in : null),
    userId: d.user?.id ?? null,
    email: d.user?.email ?? null,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshSession(cfg, session) {
  if (!session?.refreshToken) return null;
  const base = await authBase(cfg);
  const keyRes = await fetch(`${cfg.appUrl}/api/perch-terminal/cli-auth/config`, {
    headers: { Accept: "application/json", "User-Agent": cfg.userAgent },
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json()).catch(() => null);
  const apikey = keyRes?.supabaseAnonKey;
  if (!apikey) return null;
  const res = await fetch(`${base}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey, Authorization: `Bearer ${apikey}` },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
    signal: AbortSignal.timeout(20_000),
  });
  const d = await res.json().catch(() => ({}));
  if (res.status !== 200 || !d?.access_token) return null;
  return {
    ...session,
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? session.refreshToken,
    expiresAt: d.expires_at ?? (d.expires_in ? Math.floor(Date.now() / 1000) + d.expires_in : session.expiresAt),
    userId: d.user?.id ?? session.userId,
    email: d.user?.email ?? session.email,
    updatedAt: new Date().toISOString(),
  };
}

async function probePlan(cfg, token) {
  if (!token) return null;
  try {
    const res = await fetch(`${cfg.appUrl}/api/perch-terminal/cli-plan`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) return { ok: false, status: res.status };
    const d = await res.json();
    return { ok: true, planRequired: d.planRequired === true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function createAdmin({ cfg, store, ledger, getAccount, listAccounts, stats, reqLog, log }) {
  const adminToken = process.env.PERCH_ADMIN_TOKEN?.trim() || loadOrCreateAdminToken(cfg.dataDir);
  const pending = new Map(); // name -> { verifier, provider, at }

  function authorized(req) {
    const h = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m && safeEqual(m[1].trim(), adminToken)) return true;
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams.get("token");
    return !!(q && safeEqual(q, adminToken));
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
  }

  function accountStatus(entry) {
    const acc = getAccount(entry.name);
    const s = acc?.session;
    const st = stats.get(entry.name) || { requests: 0, errors: 0, tokens: 0 };
    const now = Math.floor(Date.now() / 1000);
    const sem = acc && (cfg.backend === "cli" ? acc.cliSemaphore : acc.semaphore);
    const used = ledger.month(entry.name);
    const spentPt = Math.round((used.costUsd || 0) * 1000);
    const allowancePt = Number.isFinite(entry.allowancePt) ? entry.allowancePt : 20000;
    return {
      name: entry.name,
      label: entry.label,
      enabled: entry.enabled,
      keyMasked: maskKey(entry.key),
      email: s?.email || null,
      userId: s?.userId || null,
      configured: !!s?.accessToken,
      expiresAt: s?.expiresAt || null,
      expiresInSec: s?.expiresAt ? s.expiresAt - now : null,
      planRequired: acc?.planRequired ?? null,
      planCheckedAt: acc?.planCheckedAt || null,
      activeRequests: sem?.active ?? 0,
      queued: sem?.depth ?? 0,
      requests: st.requests,
      errors: st.errors,
      tokens: st.tokens,
      spentPt,
      allowancePt,
      remainingPt: Math.max(0, allowancePt - spentPt),
      month: { costUsd: used.costUsd || 0, pt: spentPt, tokens: used.tokens || 0, requests: used.requests || 0 },
      lastAt: st.lastAt || null,
      lastStatus: st.lastStatus ?? null,
      lastError: st.lastError || null,
    };
  }

  async function overview() {
    const list = store.list();
    const accounts = list.map(accountStatus);
    const totals = accounts.reduce(
      (a, x) => ({
        requests: a.requests + x.requests,
        errors: a.errors + x.errors,
        tokens: a.tokens + x.tokens,
      }),
      { requests: 0, errors: 0, tokens: 0 },
    );
    const month = ledger.total();
    return {
      ok: true,
      backend: cfg.backend || "http",
      appUrl: cfg.appUrl,
      uptimeSec: Math.round(process.uptime()),
      kpis: {
        accounts: accounts.length,
        monthPt: Math.round((month.costUsd || 0) * 1000),
        monthUsd: month.costUsd || 0,
        healthy: accounts.filter((a) => a.configured && a.enabled && a.planRequired !== true && (a.expiresInSec == null || a.expiresInSec > 0)).length,
        attention: accounts.filter((a) => !a.configured || a.enabled === false || a.planRequired === true || (a.expiresInSec != null && a.expiresInSec <= 0)).length,
        ...totals,
      },
      accounts,
      logs: reqLog.list(),
      loginPending: [...pending.keys()],
    };
  }

  async function handle(req, res, pathname, method) {
    if (method === "GET" && (pathname === "/admin" || pathname === "/admin/")) {
      const file = path.join(PANEL_DIR, "index.html");
      const body = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (method === "GET" && (pathname === "/admin/app.js" || pathname === "/admin/style.css")) {
      const name = pathname.endsWith(".js") ? "app.js" : "style.css";
      const body = fs.readFileSync(path.join(PANEL_DIR, name));
      res.writeHead(200, {
        "Content-Type": name.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(body);
    }
    if (!pathname.startsWith("/admin/api/")) return send(res, 404, { ok: false, error: "not found" });
    if (!authorized(req)) return send(res, 401, { ok: false, error: "unauthorized" });

    const parts = pathname.slice("/admin/api/".length).split("/").filter(Boolean);
    const [resource, name, action] = parts;

    try {
      if (resource === "overview" && method === "GET") {
        // Refresh plan state opportunistically (cheap: one upstream GET per account).
        await Promise.all(store.list().map(async (entry) => {
          const acc = getAccount(entry.name);
          if (!acc?.session?.accessToken) return;
          if (acc.planCheckedAt && Date.now() - acc.planCheckedAt < 120_000) return;
          const p = await probePlan(cfg, acc.session.accessToken);
          if (p?.ok) { acc.planRequired = p.planRequired; acc.planCheckedAt = Date.now(); }
        }));
        return send(res, 200, await overview());
      }

      if (resource === "logs" && method === "GET") return send(res, 200, { ok: true, logs: reqLog.list() });

      if (resource === "models" && method === "GET") {
        if (cfg.backend === "cli") return send(res, 200, { ok: true, models: CLI_MODELS });
        const entry = store.list().find((e) => e.enabled);
        if (!entry) return send(res, 200, { ok: true, models: [] });
        const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/models`, {
          headers: { Authorization: `Bearer ${entry.key}` },
          signal: AbortSignal.timeout(10_000),
        }).then((x) => x.json()).catch(() => null);
        return send(res, 200, { ok: true, models: (r?.data || []).map((m) => m.id) });
      }

      if (resource === "test" && method === "POST") {
        const body = await readJson(req);
        const entry = body.account ? store.get(body.account) : store.list().find((e) => e.enabled);
        if (!entry) return send(res, 400, { ok: false, error: "没有可用账号" });
        const started = Date.now();
        const payload = {
          model: body.model || (cfg.backend === "cli" ? "auto" : "default"),
          messages: [{ role: "user", content: String(body.prompt || "你好") }],
        };
        let status = 0;
        let data = null;
        try {
          const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.key}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(180_000),
          });
          status = r.status;
          data = await r.json().catch(() => null);
        } catch (e) {
          return send(res, 200, { ok: false, status: 0, ms: Date.now() - started, account: entry.name, error: e.message });
        }
        const content = data?.choices?.[0]?.message?.content ?? null;
        return send(res, 200, {
          ok: status === 200 && !data?.error,
          status,
          ms: Date.now() - started,
          account: entry.name,
          model: data?.model || payload.model,
          content,
          usage: data?.usage || null,
          costUsd: Number.isFinite(data?.cost_usd) ? data.cost_usd : null,
          error: data?.error?.message || (status === 200 ? null : `HTTP ${status}`),
        });
      }

      if (resource === "accounts" && !name) {
        if (method === "GET") return send(res, 200, { ok: true, accounts: store.list().map(accountStatus) });
        if (method === "POST") {
          const body = await readJson(req);
          const entry = store.add({ name: body.name, key: body.key, label: body.label });
          log("info", `admin: account ${entry.name} added`);
          return send(res, 201, { ok: true, account: accountStatus(entry) });
        }
      }

      if (resource === "accounts" && name === "_sample" ) return send(res, 400, { ok: false });

      if (resource === "accounts" && name && !action) {
        if (method === "PATCH") {
          const body = await readJson(req);
          const e = store.update(name, body);
          if (!e) return send(res, 404, { ok: false, error: "账号不存在" });
          return send(res, 200, { ok: true, account: accountStatus(e) });
        }
        if (method === "DELETE") {
          const ok = store.remove(name);
          pending.delete(name);
          return send(res, ok ? 200 : 404, { ok });
        }
      }

      if (resource === "accounts" && name && action === "reveal" && method === "POST") {
        const e = store.get(name);
        if (!e) return send(res, 404, { ok: false, error: "账号不存在" });
        return send(res, 200, { ok: true, key: e.key });
      }

      if (resource === "accounts" && name && action === "refresh" && method === "POST") {
        const session = store.readSession(name);
        if (!session) return send(res, 400, { ok: false, error: "该账号还没有登录会话" });
        const next = await refreshSession(cfg, session);
        if (!next) return send(res, 502, { ok: false, error: "刷新失败，请重新登录" });
        store.writeSession(name, next);
        const acc = getAccount(name);
        if (acc) acc.reloadSession();
        return send(res, 200, { ok: true, account: accountStatus(store.get(name)) });
      }

      if (resource === "accounts" && name && action === "login" && method === "POST") {
        const entry = store.get(name);
        if (!entry) return send(res, 404, { ok: false, error: "账号不存在" });
        const body = await readJson(req).catch(() => ({}));
        const provider = body.provider === "github" ? "github" : "google";
        const port = Number(body.port || process.env.PERCH_LOGIN_PORT || 18081);
        const { verifier, challenge } = pkcePair();
        pending.set(name, { verifier, provider, at: Date.now() });
        const params = new URLSearchParams({
          provider,
          redirect_to: `http://127.0.0.1:${port}/callback`,
          code_challenge: challenge,
          code_challenge_method: "s256",
          prompt: "select_account",
          skip_http_redirect: "1",
        });
        return send(res, 200, {
          ok: true,
          url: `${cfg.appUrl}/api/perch-terminal/cli-auth/start?${params}`,
          port,
        });
      }

      if (resource === "accounts" && name && action === "login-finish" && method === "POST") {
        const p = pending.get(name);
        if (!p) return send(res, 400, { ok: false, error: "登录流程已过期，请重新生成链接" });
        if (Date.now() - p.at > 20 * 60_000) {
          pending.delete(name);
          return send(res, 400, { ok: false, error: "登录流程超时，请重新生成链接" });
        }
        const body = await readJson(req);
        let code = typeof body.code === "string" ? body.code.trim() : "";
        if (!code && typeof body.redirect === "string") {
          try { code = new URL(body.redirect).searchParams.get("code") || ""; } catch {}
        }
        if (!code) return send(res, 400, { ok: false, error: "没有从粘贴的地址里找到 code 参数" });
        const session = await exchangePkce({ cfg, code, verifier: p.verifier });
        store.writeSession(name, session);
        pending.delete(name);
        const acc = getAccount(name);
        if (acc) { acc.reloadSession(); }
        return send(res, 200, { ok: true, account: accountStatus(store.get(name)) });
      }

      return send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      log("error", `admin ${pathname}: ${e.message}`);
      return send(res, e.status || 500, { ok: false, error: e.message });
    }
  }

  return { handle, adminToken };
}

module.exports = { createAdmin, probePlan, refreshSession, authBase, maskKey };
