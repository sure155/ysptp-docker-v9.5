# 📺 央视频全频道直播 v9.5（VPS Docker + Cloudflare Worker）

## 📢 首发地址
- **社区**：[Gary's Club](https://t.me/garysclub)
- **频道**：[Gary's Club Channel](https://t.me/garysclubchannel)  
> ⚠️ **其他任何分发渠道均非作者本人！**

---
## ⚠️ 画质说明（VPS / CF Worker 通用限制）

**1080P 低码（约 3~4Mbps）可正常观看；1080P 高码（10Mbps 以上）不可用。**

原因：这是央视频的原理性限制，而非本项目的缺陷。央视频的高码流（4K/1080P 高码）地址必须通过**设备注册**（设备指纹 + 设备认证）后才能获取，而 VPS 与 Cloudflare Worker 这类无真实终端设备环境不具备注册条件，上游只能下发低码率地址。任何运行在无设备注册条件的服务器/边缘节点上的方案都受此限制。

---
## ✨ v9.5 核心特性

1. **双引擎四层全自动兜底** — 设备协议/JCE/bkliveinfo/备用通道逐级回退，不断流
2. **64 路独立频道** — 央视 30 路 + 卫视 34 路，全部走独立设备
3. **7 天时移回看** — 原生支持，完美适配 TiviMate / APTV
4. **VPS 优化** — `--no-4k` 跳过 4K 设备协议，仅走 1080p JCE，适合海外低带宽场景
5. **HMAC 代理安全** — 防 SSRF 攻击，proxy token 签名验证
6. **引擎就绪检测** — `/health` 返回 `engine_ready`，可控启动依赖
7. **控制面/媒体面分离** — `control_plane` 模式，稳定可靠
8. **Cloudflare Worker 版** — 单文件部署，JCE 时移合成直播 + bkliveinfo 双通路自动切换，支持 7 天回看（见下文部署章节）

---
## 🌩 Cloudflare Worker 部署（`cf-worker-ysp-live.js`）

### 特性
- **单文件** `cf-worker-ysp-live.js`，无构建、无依赖，粘贴即用
- **JCE 时移合成直播**（auto 模式：JCE 失败自动切 bkliveinfo 并"粘住" 10 分钟，避免来回切换导致卡顿）
- **7 天时移回看**（分段拼接兜底，最长跨度可通过 `CATCHUP_MAX` 配置，默认 4 小时）
- **多源 EPG 回退** + Cache API 缓存 1 小时
- 60+ 频道（央视 / CGTN / 卫视 / 剧场频道）

### 部署步骤

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com) → **Workers & Pages** → **Create Worker**
2. 将 `cf-worker-ysp-live.js` 全部内容粘贴到编辑器，保存并部署
3. （可选）添加自定义域名，指向该 Worker
4. （可选）设置以下环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `TOKEN` | 空 | 访问口令，设置后所有路径（除 `/` 和 favicon）都需 `?token=xxx` |
| `LIVE_MODE` | `auto` | `auto`（JCE 优先，失败切 bk 并粘住 10 分钟）/ `jce` / `bk` |
| `GUID` | 随机 | 32 位 hex，固定设备 ID（不设则每个 isolate 随机生成） |
| `CATCHUP_TZ` | `+08:00` | 回看时间字符串时区，可填 `+08:00` / `utc` / `Asia/Shanghai` / `auto`（取访问者 IP 时区） |
| `CATCHUP_MAX` | `14400` | 单次回看最长跨度（秒），范围 600~43200 |
| `NATIVE_GZIP` | 空 | 设为 `1` 时 JCE 请求使用 CompressionStream 压缩 |

### 订阅地址

| 用途 | 地址 |
|------|------|
| 通用订阅（TVBox / 影视仓 / APTV 等） | `https://<你的域名>/all.m3u` |
| ynoTV / Kodi / TiviMate（UTC 回看参数） | `https://<你的域名>/all.m3u?mode=utc` |
| 仅 4K/8K 频道标签 | `https://<你的域名>/all.m3u?k4=1` |
| EPG 节目单 | `https://<你的域名>/epg.xml` / `epg.xml.gz` |
| 健康检查 | `https://<你的域名>/health` |
| 最近请求日志 | `https://<你的域名>/last` |
| 频道诊断（双通路 + 回看自检） | `https://<你的域名>/cctv1.m3u8?debug=1` |

> 设置 `TOKEN` 后，订阅地址需附加 `?token=你的口令`（`/all.m3u` 会自动携带）。

### 排障
- 打开 `https://<域名>/<频道>.m3u8?debug=1`（如 `/cctv6.m3u8?debug=1`）查看两条直播通路状态、回看覆盖率和分片可达性
- 若回看提示时区问题：设置 `CATCHUP_TZ=auto`，或在 URL 加 `&tz=<你设备的时区>`

---
## 📱 推荐播放器

| 平台 | 推荐软件 | 订阅链接 |
|------|----------|----------|
| Windows | **ynoTV** | 订阅链接末尾加 `?mode=utc`，即 `https://<你的域名>/all.m3u?mode=utc` |
| 安卓 TV | **vstv** | 直接使用通用链接 `https://<你的域名>/all.m3u`，**无需添加参数** |
| 其他 | **TiviMate / Kodi** | 直接使用通用链接 `https://<你的域名>/all.m3u`，**无需添加参数** |
| 国产软件（TVBox / 影视仓 等） | 直接使用通用链接 | `https://<你的域名>/all.m3u`，**不用添加任何参数** |

> **EPG 节目单显示说明**：**仅 ynoTV 需加 `?mode=utc`**（回看改用 `utc={utc}&lutc={lutc}` 时间戳，与时区无关）才能正确显示节目单；vstv、TiviMate、Kodi、国产软件直接订阅通用链接即可正常显示节目单。

## 🛠 特性对比

| | 原版 v9.5 | 本版 (lite) |
|--|---|---|
| 高码率 / 4K 设备协议（设备注册、AES-GCM/RSA 会话） | 有 | **已删除** |
| Node.js「Web WASM 伴生引擎」、`/engine_proxy`、`?k4=1` | 有 | **已删除**（镜像不再含 Node） |
| 低码率路径：JCE 滚动窗口 → bkliveinfo 备用 | 有 | **保留，逻辑不变** |
| 时移回看入口、限流退避、空闲静默 | 有 | **保留** |
| 数据持久化目录 / 数据卷 | 需要 | **不需要**（无状态，只读文件系统） |
| 访问口令 | 无 | **新增** `YSP_TOKEN`，所有地址带 `/<口令>/` 前缀 |
| 反代 / 域名 / https 友好 | 仅读 Host | **新增** `YSP_PUBLIC_URL`，识别 `X-Forwarded-Proto/Host` |
| 分片经 VPS 中转（可选） | 仅高码路径 | **新增**，低码路径也可选开启 `YSP_PROXY_SEGMENTS=1` |
| 运行方式 | root | 非 root、`cap_drop: ALL`、`init: true`、HTTP/1.1 keep-alive、SIGTERM 优雅退出 |
| 代码规模 | 约 3700 行 | 约 1700 行，纯标准库 |

> 本版本是使用者自行改造的衍生版，不是原作者发布的。原作者社区：https://t.me/garysclub　频道：https://t.me/garysclubchannel

### ⚡ VPS 部署（Docker）

```bash
# 一键部署
curl -sSL https://raw.githubusercontent.com/sure155/ysptp-docker-v9.5/main/install.sh | bash

# 或手动部署
git clone https://github.com/sure155/ysptp-docker-v9.5.git /opt/ysp-live-lite
cd /opt/ysp-live-lite
docker compose up -d --build
```

容器启动后自动设置随机访问口令，订阅地址为：
```
http://<VPS_IP>:8767/<YSP_TOKEN>/all.m3u
```

如需使用域名 + https（推荐），在 `.env` 里设 `HOST_BIND=127.0.0.1`、`YSP_PUBLIC_URL=https://tv.example.com`，然后用 Caddy/Nginx 反代即可。详见 README 顶部的环境变量说明。

### 🐳 Docker Compose 配置

```yaml
services:
  ysp-live:
    build: .
    image: ysp-live-lite:1.0
    container_name: ysp-live-lite
    restart: unless-stopped
    init: true            # SIGTERM 正常转发
    ports:
      - "${HOST_BIND:-0.0.0.0}:${HOST_PORT:-8767}:8767"
    environment:
      TZ: Asia/Shanghai
      YSP_TOKEN: ${YSP_TOKEN:?请填写}
      YSP_PUBLIC_URL: ${YSP_PUBLIC_URL:-}   # 域名反代时填 https://tv.example.com
      YSP_PROXY_SEGMENTS: ${YSP_PROXY_SEGMENTS:-0}  # 1=分片经VPS中转（境外播放用）
      YSP_CACHE_MB: ${YSP_CACHE_MB:-64}
      YSP_EXCLUDE_CHANNELS: ${YSP_EXCLUDE_CHANNELS:-}
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 384m
```

### 🔧 环境变量

| 变量 | 默认 | 说明 |
|--|---|---|
| `YSP_TOKEN` | *(必填)* | 访问口令，8~64 位。设置后地址形如 `/<口令>/all.m3u` |
| `YSP_PUBLIC_URL` | 空 | 写进 m3u/m3u8 的基础地址；空则按请求 Host 自动生成 |
| `YSP_PROXY_SEGMENTS` | `0` | `0`=播放器直连央视CDN（省流量）；`1`=分片经VPS中转（境外播放用） |
| `YSP_CACHE_MB` | `64` | 中转模式的分片内存缓存（MB） |
| `YSP_SEG_ALLOW_EXTRA` | 空 | 中转模式额外放行的 CDN 后缀 |
| `YSP_EXCLUDE_CHANNELS` | 空 | 屏蔽频道，如 `cctv4k,cctv8k,cctv164k` |
| `HOST_BIND` / `HOST_PORT` | `0.0.0.0` / `8767` | 宿主机映射（仅 docker-compose 生效） |
## ⚠️ 友情提醒

1. **画质限制**：仅 1080P 低码（3~4Mbps），高码需设备注册，VPS/Worker 环境不具备（见开头说明）
2. **流量消耗**：1080p 低码约 2~3GB/小时，请留意带宽
3. **网络要求**：建议在稳定的网络环境下运行
4. **翻墙分流**：如遇播放问题，需将 `*.cctv.cn` 直连，参考 `ysp.list` 分流规则

---
## 🙏 致谢

1. 感谢 **IPTV 直播源总部** 分享的算法源码
2. 感谢 **Gary's Club** 群里小伙伴 **ll** 提供大量频道的 live_id
3. 感谢 **APTV 群主** 提供的技术帮助
