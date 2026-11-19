# ysp-live-lite · 央视频直播网关（VPS / Docker 低码精简版）

基于 Gary's Club 的 **ysp-live 9.8**（Docker 版）改造：去掉高码率 / 4K 设备协议和 Node 伴生引擎，只保留低码率（1080p）路径，并补上 VPS 公网部署需要的访问口令、反代支持和可选分片中转。

> 本版本是使用者自行改造的衍生版，**不是原作者发布的**。原作者社区：https://t.me/garysclub　频道：https://t.me/garysclubchannel
> 原包未附带许可证，请仅作个人使用，不要公开分发你的订阅地址。

## 改了什么

| | 原 9.8 | 本版 |
|---|---|---|
| 高码率 / 4K / 8K 设备协议（设备注册、AES-GCM/RSA 会话、心跳、并发池） | 有 | **已删除** |
| Node.js「Web WASM 伴生引擎」、`/engine_proxy`、`/proxy.ts`、`?k4=1` | 有 | **已删除**（镜像不再含 Node） |
| 低码率路径：JCE 滚动窗口 → bkliveinfo 备用 | 有 | **保留，逻辑不变** |
| 时移回看入口、限流退避（单次 ≥2s 串行、429 递增冷却）、空闲 20 秒停止后台轮询 | 有 | **保留** |
| 数据持久化目录 / 数据卷 | 需要 | **不需要**（无状态，容器根文件系统只读） |
| 访问口令 | 无 | **新增** `YSP_TOKEN`，地址形如 `/<口令>/all.m3u` |
| 反代 / 域名 / https 友好 | 仅读 Host | **新增** `YSP_PUBLIC_URL`，并识别 `X-Forwarded-Proto/Host` |
| 分片经 VPS 中转 | 仅高码路径 | **新增**，低码路径可选开启（见下） |
| 运行方式 | root | 非 root、`cap_drop: ALL`、`init: true`、HTTP/1.1 keep-alive、SIGTERM 优雅退出 |
| 代码规模 | 约 3700 行 | 约 1700 行，纯标准库 |

我对比过协议层：同样的随机种子和时间下，JCE 请求体、cKey 签名、bkliveinfo 请求、播放列表窗口解析与原版**逐字节一致**，没有改动低码率路径的任何请求方式。

## 部署（一行命令 / 3 步）

### 一行命令（推荐，直接从 GitHub 执行）

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/sure155/ysptp-docker-v9.5/main/install.sh)
```

### 3 步手动部署

```bash
# 1. 上传并解压到 VPS，进入目录
cd ysp-live-lite-docker

# 2. 生成配置并设置口令
cp .env.example .env
sed -i "s/^YSP_TOKEN=.*/YSP_TOKEN=$(openssl rand -hex 16)/" .env    # 或手动编辑 .env 里的 YSP_TOKEN=

# 3. 构建并启动
docker compose up -d --build
docker compose logs -f         # 看到「启动成功: 64 个频道」即可
```

未设置 `YSP_TOKEN` 时 compose 会直接报错并提示，避免裸奔上公网。放行 VPS 安全组 / 防火墙的 TCP 8767（走反代则只放行 443）。

播放器订阅地址：

```
http://你的VPS_IP:8767/<YSP_TOKEN>/all.m3u
```

回看（catchup）、EPG、台标沿用原版设置；`?group=央视` / `?group=卫视` 可只取一类。

## 用域名 + https（推荐）

`.env` 里设 `HOST_BIND=127.0.0.1`、`YSP_PUBLIC_URL=https://tv.example.com`，然后用反代：

Caddy（自动签证书）：

```
tv.example.com {
    reverse_proxy 127.0.0.1:8767
}
```

Nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8767;
    proxy_http_version 1.1;
    proxy_set_header Host $host;                    # 必须，否则生成的链接会指向 127.0.0.1
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```

订阅地址变为 `https://tv.example.com/<YSP_TOKEN>/all.m3u`。

## 分片：直连还是中转（`YSP_PROXY_SEGMENTS`）

低码路径返回给播放器的 `.m3u8` 里，分片是央视 CDN 的绝对地址。

- **`0`（默认，与原版行为一致）**：播放器直接向央视 CDN 取分片。VPS 只做播放列表，几乎不耗流量，对低带宽 / 限流量的 VPS 最友好。
- **`1`**：分片全部经 VPS 转发（带内存缓存，多人看同一频道只回源一次）。适合：**播放设备在境外或直连央视 CDN 被拒**、需要 https（浏览器播放器会拦截 https 页面里的 http 分片）、或分片地址与 VPS 的 IP 绑定。代价是每个观众占用一路出口带宽和流量——**VPS 带宽小的话反而会卡**。

先用 `0`；如果播放列表能拿到但画面起不来 / 分片 403，再切 `1` 对比。中转只放行央视相关 CDN 域名（白名单见 `SEG_ALLOWED_SUFFIXES`），遇到被拒的域名日志里会打印，可用 `YSP_SEG_ALLOW_EXTRA` 追加。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `YSP_TOKEN` | *(compose 必填)* | 访问口令，8~64 位 `A-Za-z0-9_-`。设置后所有地址带 `/<口令>/` 前缀，错误口令一律 404 |
| `YSP_PUBLIC_URL` | 空 | 写进 m3u/m3u8 的基础地址；空则按请求的 Host / 反代头生成 |
| `YSP_PROXY_SEGMENTS` | `0` | 见上节 |
| `YSP_CACHE_MB` | `64` | 中转模式的分片缓存 |
| `YSP_SEG_ALLOW_EXTRA` | 空 | 中转模式额外放行的域名后缀，如 `.foo.com` |
| `YSP_EXCLUDE_CHANNELS` | 空 | 屏蔽频道，如 `cctv4k,cctv8k,cctv164k` |
| `HOST_BIND` / `HOST_PORT` | `0.0.0.0` / `8767` | 宿主机映射（仅 compose 用） |
| `PY_IMAGE` | `python:3.12-slim` | 基础镜像；国内可用 `docker.m.daocloud.io/library/python:3.12-slim` |

## 关于 4K / 8K 频道

频道表保持原样的 64 路。`CCTV-4K / 8K / 16-4K` 三个频道仍在列表里，但没有高码设备协议后只能走 1080p 低码路径（等同于原版的 `--no-4k` 模式）。如果这几路在你那边放不出来，用 `YSP_EXCLUDE_CHANNELS=cctv4k,cctv8k,cctv164k` 屏蔽即可。

## 排障

- `http://IP:8767/<口令>/diag`：每个频道的模式（jce/bk）、上次刷新时间、最近错误，以及最近 30 条日志。
- `http://IP:8767/<口令>/health`：JSON 状态，含 JCE 限流冷却剩余秒数。
- `docker compose logs -f`：实时日志。
- **返回 503「限流冷却中」**：上游在限流，程序按原版逻辑退避（首次 60 秒，连续限流递增到 900 秒），这是尊重限制而不是故障。反复刷新 / 切台不会更快恢复。
- **所有频道都取不到、`/diag` 里全是 403 / 连接错误**：VPS 的 IP 段可能被上游限制（机房 IP、境外 IP 都有可能）。可先在 VPS 上 `curl -sI https://jacc.ysp.cctv.cn` 和 `curl -sI https://bkliveinfo.ysp.cctv.cn` 看能否连通；这属于上游访问限制，改代码解决不了。
- 容器 `unhealthy`：`docker compose logs` 看启动报错（最常见是 `YSP_TOKEN` 格式不合法）。

## 验证与局限（请知悉）

- 开发环境无法访问央视上游，**没有做真实频道的播放验证**。已做的验证：① 本地模拟 CDN 的端到端测试（`python3 tests/test_lite.py`，约 63 项：口令、直连/中转、Range、重定向、SSRF 防护、keep-alive、并发、SIGTERM 等全部通过）；② 与原版协议层逐字节对比一致。
- 没有 Docker 环境，Dockerfile / compose 只做了语法校验，**没有实际 `docker build`**。如构建报错请把日志发给我。
- 上游是否放行你的 VPS、各频道此刻是否可用、流畅度如何，取决于上游和网络，无法承诺。
## Cloudflare Worker 独立部署（可选，无需 VPS）

如果你有 Cloudflare 账号，可以直接将 `cf-worker-ysp-live.js` 部署到 Cloudflare Workers，**完全在 Worker 上运行**，无需任何 VPS：

1. **直播/回看/EPG 全在 Worker 内完成**（JCE/BK 协议、回看拼接、EPG 多源回退、分片代理）
2. **生成可直接播放的订阅链接**（`/all.m3u`、单频道 `.m3u8`、EPG、分片代理 `/seg`）
3. **隐藏源站 IP**，仅暴露 Worker 域名
4. **自动 HTTPS**，避免浏览器拦截 HTTP 分片

### 部署步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → **Create Application** → **Create Worker**
3. 将 `cf-worker-ysp-live.js` 的全部内容粘贴到编辑器
4. 点击 **Deploy** → **Save and Deploy**
5. 获取 Worker URL（如 `https://ysp-live.xxx.workers.dev`）

### 环境变量（在 Worker 设置 → Variables 中配置，均可选）

| 变量 | 说明 |
|------|------|
| `TOKEN` | 访问口令，设置后所有路径（除 `/` 和 `/favicon.ico`）需带 `?token=xxx` |
| `LIVE_MODE` | `auto`(默认) \| `bk` \| `jce` — 直播模式选择 |
| `PROXY_TS` | 设为 `1` 时默认通过 Worker 代理 `.ts` 分片 |
| `NATIVE_GZIP` | 设为 `1` 时 JCE 请求用 `CompressionStream` 压缩 |
| `GUID` | 32 位 hex 固定设备 ID（不设则每个 isolate 随机生成） |
| `CATCHUP_TZ` | 回看时间时区，默认 `+08:00`，可填 `utc` / `Asia/Shanghai` / `auto` |
| `CATCHUP_MAX` | 单次回看最长跨度(秒)，默认 `14400` (4h) |
| `PDT_OVERLAP_MAX` | 容许相邻分片 PDT 重叠最大秒数，默认 `1.2` |

### 访问地址（部署后直接可用）

```
# 通用订阅 (TVBox / 影视仓 / APTV / IPTVnator 等)
https://<your-worker>.workers.dev/all.m3u?token=<TOKEN>

# 分片代理订阅（直连 CDN 偶发黑屏/断连时推荐）
https://<your-worker>.workers.dev/all.m3u?token=<TOKEN>&proxy=1

# ynoTV / TiviMate / Kodi (UTC 模式回看)
https://<your-worker>.workers.dev/all.m3u?token=<TOKEN>&mode=utc

# 单频道
https://<your-worker>.workers.dev/cctv1.m3u8?token=<TOKEN>

# EPG
https://<your-worker>.workers.dev/epg.xml?token=<TOKEN>

# 健康检查 / 诊断
https://<your-worker>.workers.dev/health?token=<TOKEN>
https://<your-worker>.workers.dev/cctv1.m3u8?token=<TOKEN>&debug=1&probe=1
```

### 自定义域名（可选）

在 Cloudflare DNS 添加 CNAME：
- **类型**: CNAME
- **名称**: tv (或任意子域名)
- **目标**: `<your-worker>.workers.dev`
- **代理状态**: 已代理（橙色云）

然后在 Worker 设置 → Triggers → **Add Custom Domain** 绑定该域名。

### 注意事项

1. Worker 免费版每天 100,000 次请求，ysp-live 低码模式几乎不耗流量，通常足够
2. 如果需要更高并发或长时间回看，可考虑 Workers Paid Plan ($5/月，1000万次/天)
3. 源站 IP 完全不暴露，仅 Worker 域名对外


## 验证与局限（请知悉）
