#!/bin/bash
# ysp-live-lite 一键安装脚本 (VPS 部署)
# 支持 Debian/Ubuntu

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 1. 检测系统并安装 Docker
echo_info "检查系统..."
if [ -f /etc/debian_version ]; then
    OS="debian"
elif [ -f /etc/lsb-release ]; then
    OS="ubuntu"
else
    echo_error "仅支持 Debian/Ubuntu 系统"
    exit 1
fi

echo_info "检测到 $OS 系统"

# 检查 Docker 是否已安装
if ! command -v docker &> /dev/null; then
    echo_info "Docker 未安装，开始安装..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    systemctl start docker
    systemctl enable docker
    rm get-docker.sh
    echo_info "Docker 安装完成"
else
    echo_info "Docker 已安装 (版本: $(docker --version))"
fi

# 2. 拉取代码
echo_info "拉取 ysp-live-lite 代码..."
if [ ! -d "ysp-live-lite" ]; then
    git clone https://github.com/sure155/ysptp-docker-v9.5.git ysp-live-lite
else
    cd ysp-live-lite
    git pull
fi
cd ysp-live-lite

# 3. 生成配置
echo_info "生成配置文件..."
if [ ! -f ".env" ]; then
    cp .env.example .env
fi

# 生成随机 Token
TOKEN=$(openssl rand -hex 16)
sed -i "s/^YSP_TOKEN=.*/YSP_TOKEN=$TOKEN/" .env

echo_info "生成的访问口令: $TOKEN"

# --- 新增：YSP_PROXY_SEGMENTS 设置 ---
echo_info "是否启用 TS 分片代理模式?"
echo_info "  0 (默认)：播放器直接向央视 CDN 取分片。VPS 只做播放列表，几乎不耗流量"
echo_info "  1：分片全部经 VPS 转发（带内存缓存，多人看同一频道只回源一次）。适合：播放设备在境外或直连央视 CDN 被拒、需要 https、或分片地址与 VPS IP 绑定"
read -p "请输入选项 [默认 0]: " PROXY_SEG_CHOICE
PROXY_SEG_CHOICE=${PROXY_SEG_CHOICE:-0}
if [ "$PROXY_SEG_CHOICE" = "1" ]; then
    sed -i "s/^YSP_PROXY_SEGMENTS=.*/YSP_PROXY_SEGMENTS=1/" .env
    echo_info "已启用 TS 分片代理模式 (YSP_PROXY_SEGMENTS=1)"
elif [ "$PROXY_SEG_CHOICE" = "0" ]; then
    sed -i "s/^YSP_PROXY_SEGMENTS=.*/YSP_PROXY_SEGMENTS=0/" .env
    echo_info "保持默认直连模式 (YSP_PROXY_SEGMENTS=0)"
else
    echo_warn "无效选项，保持默认直连模式 (YSP_PROXY_SEGMENTS=0)"
    sed -i "s/^YSP_PROXY_SEGMENTS=.*/YSP_PROXY_SEGMENTS=0/" .env
fi

# 4. 清理旧容器（如有）
echo_info "检查并清理旧容器..."
docker rm -f ysp-live-lite 2>/dev/null && echo_info "已移除旧容器" || true

# 5. 构建并启动容器
echo_info "构建并启动容器..."
docker compose up -d --build

# 6. 等待容器启动
echo_info "等待容器启动..."
sleep 5

# 7. 检查容器状态
if docker ps | grep -q ysp-live-lite; then
    echo_info "容器启动成功!"
    echo_info "订阅地址: http://$(hostname -I | awk '{print $1}'):8767/$TOKEN/all.m3u"
    echo_info """
    访问地址:
      - 播放列表: http://$(hostname -I | awk '{print $1}'):8767/$TOKEN/all.m3u
      - 健康检查: http://$(hostname -I | awk '{print $1}'):8767/$TOKEN/health
      - 诊断信息: http://$(hostname -I | awk '{print $1}'):8767/$TOKEN/diag
    """
else
    echo_error "容器启动失败，请检查日志: docker compose logs"
    exit 1
fi

# 8. 可选：配置防火墙
echo_info "配置防火墙..."
if command -v ufw &> /dev/null; then
    ufw allow 8767/tcp
    echo_info "防火墙规则已添加"
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=8767/tcp
    firewall-cmd --reload
    echo_info "防火墙规则已添加"
fi

echo_info "安装完成!"
