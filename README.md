# 📺 央视频全频道直播 v9.5 VPS 优化版

## 📢 首发地址
- **社区**：[Gary's Club](https://t.me/garysclub)
- **频道**：[Gary's Club Channel](https://t.me/garysclubchannel)  
> ⚠️ **其他任何分发渠道均非作者本人！**

---
## ✨ v9.5 核心特性

1. **双引擎四层全自动兜底** — 设备协议/JCE/bkliveinfo/备用通道逐级回退，不断流
2. **64 路独立频道** — 央视 30 路 + 卫视 34 路，全部走独立设备
3. **7 天时移回看** — 原生支持，完美适配 TiviMate / APTV
4. **VPS 优化** — `--no-4k` 跳过 4K 设备协议，仅走 1080p JCE，适合海外低带宽场景
5. **HMAC 代理安全** — 防 SSRF 攻击，proxy token 签名验证
6. **引擎就绪检测** — `/health` 返回 `engine_ready`，可控启动依赖
7. **控制面/媒体面分离** — `control_plane` 模式，稳定可靠

---
## 🛠 VPS 优化参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `WINDOW` | 1800 | 时移窗口（秒） |
| `MAX_SEGS` | 400 | 最大缓冲区片段数 |
| `init_segs` | 400 | 初始缓冲片段数 |
| `--no-4k` | — | 跳过 4K 设备协议注册 |

---
## ⚡ 一键部署

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
## 📱 订阅信息

| 用途 | 地址 |
|------|------|
| M3U 订阅 | `http://<IP>:8767/all.m3u` |
| EPG 节目单 | `http://<IP>:8767/epg.xml` |
| 健康检查 | `http://<IP>:8767/health` |
| 诊断报告 | `http://<IP>:8767/diag` |

---
## 🚀 常用命令

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

1. **流量消耗**：1080p 约 5GB/小时，请留意带宽
2. **网络要求**：建议在稳定的网络环境下运行
3. **翻墙分流**：如遇播放问题，需将 `*.cctv.cn` 直连，参考 `ysp.list` 分流规则

---
## 🙏 致谢

1. 感谢 **IPTV 直播源总部** 分享的算法源码
2. 感谢 **Gary's Club** 群里小伙伴 **ll** 提供大量频道的 live_id
3. 感谢 **APTV 群主** 提供的技术帮助
