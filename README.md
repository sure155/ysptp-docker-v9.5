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
| 安卓 TV | **vstv** | 订阅链接末尾加 `?mode=utc`，即 `https://<你的域名>/all.m3u?mode=utc` |
| 国产软件（TVBox / 影视仓 等） | 直接使用通用链接 | `https://<你的域名>/all.m3u`，**不用添加任何参数** |

> **EPG 节目单显示说明**：国外软件（ynoTV / vstv 等）回看参数用本地时间格式化，需在订阅链接末尾加 `?mode=utc`（回看改用 `utc={utc}&lutc={lutc}` 时间戳，与时区无关）才能正确显示节目单；国产软件自带中文 EPG 时间处理，直接订阅即可正常显示节目单。

---
## 🛠 VPS 优化参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `WINDOW` | 1800 | 时移窗口（秒） |
| `MAX_SEGS` | 400 | 最大缓冲区片段数 |
| `init_segs` | 400 | 初始缓冲片段数 |
| `--no-4k` | — | 跳过 4K 设备协议注册 |

---
## ⚡ 一键部署（VPS Docker）

```bash
curl -sSL https://raw.githubusercontent.com/sure155/ysptp-docker-v9.5/main/install.sh | bash
```

> 自动拉取代码、清理旧容器、构建镜像、启动服务。部署完成后输出订阅地址。

## 🐳 Docker 版手动部署

```bash
git clone https://github.com/sure155/ysptp-docker-v9.5.git /opt/ysp-live-v9.5
cd /opt/ysp-live-v9.5
docker compose build --no-cache
docker compose up -d
```

播放器订阅地址：`http://<IP>:8767/all.m3u`

---
## 📱 订阅信息（VPS Docker 版）

| 用途 | 地址 |
|------|------|
| M3U 订阅 | `http://<IP>:8767/all.m3u` |
| EPG 节目单 | `http://<IP>:8767/epg.xml` |
| 健康检查 | `http://<IP>:8767/health` |
| 诊断报告 | `http://<IP>:8767/diag` |

---
## 🚀 常用命令（VPS Docker 版）

```bash
# 启动/更新
cd /opt/ysp-live-v9.5 && docker compose up -d --build

# 查看日志
docker logs -f ysp-live-v9.5

# 重启
docker compose restart

# 卸载
docker compose down -v && cd /opt && rm -rf ysp-live-v9.5
```

---
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
