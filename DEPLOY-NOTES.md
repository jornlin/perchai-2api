# perchai-2api 本机部署说明

- 上游项目：https://github.com/ZYHUO/perchai-2api（MIT）
- 本地 fork：https://github.com/jornlin/perchai-2api，分支 `feat/admin-panel`（含管理面板改动）
- 目录：`~/apps/perchai-2api`，容器 `perchai-2api`（restart: unless-stopped）
- 网关：http://10.0.1.36:8080/v1
- 管理面板：http://10.0.1.36:8080/admin
- 管理令牌：`data/admin-token.txt`（0600）
- 账号：jornlinsmith@gmail.com（**已被 Perch 封禁**，见文末）
- 后端：`cli`（容器内运行官方 `perchai-cli run --json`）

## 启动 / 停止 / 日志
```bash
export PATH="$HOME/.orbstack/bin:/usr/local/bin:$PATH"
cd ~/apps/perchai-2api
docker compose -f compose.local.yaml up -d        # 启动
docker compose -f compose.local.yaml restart      # 重启
docker compose -f compose.local.yaml logs -f      # 日志
docker compose -f compose.local.yaml down         # 停止
```
必须带 `-f compose.local.yaml`：上游默认 compose 只映射 127.0.0.1 且用 HTTP 后端。

## 数据与账号
```
data/accounts.json                          # 账号元数据：name / key / label / enabled
data/accounts/<name>/cli-auth-session.json  # 每个账号独立的会话（敏感）
data/admin-token.txt                        # 面板管理令牌
```
`accounts.json` 改动热加载，加号不用重启。每个账号必须独占目录和会话，
**不要在两处同时刷新同一个会话**：Supabase 的 refresh token 轮换会顶掉另一处。

## 管理面板
- 地址 `/admin`，输入管理令牌进入。
- 能看到：账号邮箱、令牌剩余时间、套餐状态、并发/请求/错误/tokens、最近 300 条请求日志。
- 操作：添加账号、登录/重新登录、刷新令牌、启停、复制 Key、删除。
- 加号流程：输入名字 → 点「登录」→ 打开生成的链接完成 OAuth → 浏览器会跳到
  `http://127.0.0.1:18081/callback?code=…`（打不开是正常的）→ 复制整条地址粘贴回面板。
- 登录用的是 `app.perchai.app/data-edge` 的 auth 端点；直连 Supabase 会返回
  `Unregistered API key`，这是上游当前的行为。

## 为什么用 CLI 后端
Perch 对「直连 API」有硬拦截：HTTP 后端返回 `perch_surface_required`（403），
条款只允许 Web / Desktop / CLI 三种界面。CLI 后端是官方界面，但把它包成对外 API
仍然违反条款——本账号已因此被封。

## 当前状态（2026-11-23）
Perch 返回：`This account was banned for using Perch through another app or tool,
which the terms do not allow.` 申诉邮箱 hello@perchai.app。
服务保持可启动（面板可用），但没有可用账号前 `/v1/*` 都会失败。

## 安全
- 仅限局域网，不要映射公网；明文 HTTP。
- `data/`、`.env` 当敏感数据备份。
- 不要对外共享/转售。
