# ysp-live-lite —— 央视频直播网关（VPS / Docker 低码精简版）
# 纯 Python 标准库，无需 apk/apt/pip 安装任何东西，构建时只需要能拉取基础镜像。
# 国内 VPS 拉镜像慢时，可在 .env 里设置：
#   PY_IMAGE=docker.m.daocloud.io/library/python:3.12-slim
ARG PY_IMAGE=python:3.12-slim
FROM ${PY_IMAGE}

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 不以 root 运行
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ysp

WORKDIR /app
COPY ysp-live-lite.py /app/ysp-live-lite.py

USER ysp
EXPOSE 8767

# /healthz 不需要口令、不泄露任何信息
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('YSP_PORT','8767'),timeout=3)" || exit 1

ENTRYPOINT ["python", "/app/ysp-live-lite.py"]
