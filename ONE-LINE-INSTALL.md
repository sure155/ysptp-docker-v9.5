# 一键安装命令 (Single-Line Install)

## 直接在 VPS 上执行的一行命令

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/sure155/ysptp-docker-v9.5/main/install.sh)
```

## 等效写法

```bash
wget -qO- https://raw.githubusercontent.com/sure155/ysptp-docker-v9.5/main/install.sh | bash
```

## 命令说明

- `https://raw.githubusercontent.com/sure155/ysptp-docker-v9.5/main/install.sh` — GitHub 原始文件链接
- 自动检测系统（Debian/Ubuntu）、安装 Docker、拉取代码、生成配置、启动容器
- 执行后输出订阅地址：`http://<VPS_IP>:8767/<TOKEN>/all.m3u`

## 使用方法

在 VPS 终端粘贴上述任意一行回车即可，无需提前将脚本写入本地文件。