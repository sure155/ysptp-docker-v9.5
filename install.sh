#!/bin/bash
# One-click install for ysp-live-lite (Debian)

# 1. 更新源并安装 Docker 与 openssl
apt-get update && apt-get install -y docker.io openssl
systemctl start docker && systemctl enable docker

# 2. 生成随机 Token
TOKEN=$(openssl rand -hex 4)

# 3. 拉取并运行容器
docker run -d --name ysp-live-lite --restart unless-stopped \
  -p 8767:8767 \
  -e YSP_TOKEN="$TOKEN" \
  sure155/ysp-live-lite:latest

# 4. 输出订阅地址
IP=$(hostname -I | awk '{print $1}')
echo "Subscription URL: http://${IP}:8767/${TOKEN}/all.m3u"
