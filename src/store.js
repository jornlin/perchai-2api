"use strict";
// Account store: data/accounts.json (metadata) + data/accounts/<name>/cli-auth-session.json.
// Files are the source of truth so accounts can be added or replaced without a restart.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SESSION_FILE = "cli-auth-session.json";

function newKey() {
  return `sk-perch-${crypto.randomBytes(12).toString("hex")}`;
}

function validName(name) {
  return typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,40}$/.test(name);
}

class AccountStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "accounts.json");
    this.accountsDir = path.join(dataDir, "accounts");
    this.entries = [];
    this.mtime = 0;
    this.reload();
  }

  sessionPath(name) {
    return path.join(this.accountsDir, name, SESSION_FILE);
  }

  reloadIfChanged() {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs !== this.mtime) this.reload();
    } catch {
      if (this.mtime !== 0) this.reload(); // file removed
    }
  }

  reload() {
    let data = null;
    try {
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.entries = [];
      this.mtime = 0;
      return;
    }
    try {
      data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      data = null;
    }
    if (Array.isArray(data?.accounts)) {
      this.entries = data.accounts
        .filter((e) => validName(e?.name) && typeof e?.key === "string" && e.key)
        .map((e) => ({
          name: e.name,
          key: e.key,
          label: typeof e.label === "string" ? e.label : e.name,
          enabled: e.enabled !== false,
          createdAt: e.createdAt || null,
        }));
    }
  }

  list() {
    return this.entries.map((e) => ({ ...e }));
  }

  get(name) {
    const e = this.entries.find((x) => x.name === name);
    return e ? { ...e } : null;
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const body = JSON.stringify({ version: 1, accounts: this.entries }, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  add({ name, key = null, label = null }) {
    if (!validName(name)) throw Object.assign(new Error("账号名只能用字母、数字、点、下划线或短横线"), { status: 400 });
    if (this.entries.some((e) => e.name === name)) throw Object.assign(new Error("账号名已存在"), { status: 409 });
    const accountKey = key || newKey();
    if (this.entries.some((e) => e.key === accountKey)) throw Object.assign(new Error("API key 已被其它账号占用"), { status: 409 });
    fs.mkdirSync(path.dirname(this.sessionPath(name)), { recursive: true, mode: 0o700 });
    const entry = { name, key: accountKey, label: label || name, enabled: true, createdAt: new Date().toISOString() };
    this.entries.push(entry);
    this.save();
    return { ...entry };
  }

  remove(name) {
    const idx = this.entries.findIndex((e) => e.name === name);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this.save();
    try { fs.rmSync(path.dirname(this.sessionPath(name)), { recursive: true, force: true }); } catch {}
    return true;
  }

  update(name, patch) {
    const e = this.entries.find((x) => x.name === name);
    if (!e) return null;
    if (patch.key) {
      if (this.entries.some((x) => x.name !== name && x.key === patch.key)) {
        throw Object.assign(new Error("API key 已被其它账号占用"), { status: 409 });
      }
      e.key = patch.key;
    }
    if (typeof patch.label === "string" && patch.label.trim()) e.label = patch.label.trim();
    if (typeof patch.enabled === "boolean") e.enabled = patch.enabled;
    this.save();
    return { ...e };
  }

  writeSession(name, session) {
    const p = this.sessionPath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ ...session, version: 1, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return p;
  }

  readSession(name) {
    try {
      const s = JSON.parse(fs.readFileSync(this.sessionPath(name), "utf8"));
      return s && s.accessToken ? s : null;
    } catch {
      return null;
    }
  }
}

module.exports = { AccountStore, newKey, validName, SESSION_FILE };
