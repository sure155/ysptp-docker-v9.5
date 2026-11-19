#!/bin/bash
# ysp-live-lite 一键部署脚本（VPS / Docker 低码精简版）
# 纯 Python 标准库，无需 apk/apt/pip，约 1700 行代码
set -e

REPO_URL="https://github.com/sure155/ysptp-docker-v9.5.git"
TARGET_DIR="/opt/ysp-live-lite"

echo ">>> 拉取 sure155/ysptp-docker-v9.5 项目..."
rm -rf "$TARGET_DIR"
git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
cd "$TARGET_DIR"

echo ">>> 生成访问口令并启动容器..."
cp .env.example .env
sed -i "s/^YSP_TOKEN=.*/YSP_TOKEN=$(openssl rand -hex 16)/" .env    # 自动设置随机口令

echo ">>> 构建并启动容器...（首次约 1~2 分钟）"
docker compose up -d --build

echo ">>> 等待引擎就绪（约 5~10 秒）..."
sleep 8

IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
TOKEN=$(grep '^YSP_TOKEN=' .env | cut -d= -f2)
echo ""
echo "✅ ysp-live-lite 已部署完毕"
echo "📡 订阅地址: http://$IP:8767/$TOKEN/all.m3u"
echo "📋 节目单订阅: http://$IP:8767/$TOKEN/epg.xml"
echo "💊 实时诊断: http://$IP:8767/$TOKEN/diag"
echo "📦 健康检查: http://$IP:8767/$TOKEN/health"
echo "查看日志: docker logs -f ysp-live-lite"
echo ""
echo "常用命令:"
echo "  cd /opt/ysp-live-lite && docker compose up -d --build   # 更新"
echo "  docker logs -f ysp-live-lite                            # 看日志"
echo "  docker compose restart                                  # 重启"
echo "  docker compose down -v && cd /opt && rm -rf ysp-live-lite  # 卸载"
