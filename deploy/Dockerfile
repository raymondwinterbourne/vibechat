# VibeChat 的生产镜像。构建上下文是仓库的根目录，由 deploy/compose.yaml 构建，有两个目标：
#
#   server  服务端程序（Rust，release 构建），数据放在 /data
#   web     构建好的网页，加上 Caddy：对外的唯一入口。负责 HTTPS、页面的内容安全策略，
#           把 /api、/ws 转给服务端，把 /livekit 转给群通话的媒体转发服务（LiveKit）
#
# The production images. Build context is the repository root; deploy/compose.yaml builds both targets.

ARG RUST_IMAGE=rust:1.99.0-trixie
ARG NODE_IMAGE=node:22.23.3-trixie-slim
ARG RUNTIME_IMAGE=debian:trixie-slim
ARG CADDY_IMAGE=caddy:2.11.9-alpine

# ---------- 编译服务端 ----------
FROM ${RUST_IMAGE} AS server-build
WORKDIR /src
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p vibechat-server \
    && cp target/release/vibechat-server /vibechat-server

# ---------- 构建网页 ----------
FROM ${NODE_IMAGE} AS web-build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src/client
COPY client/ ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @vibechat/web... \
    && pnpm build

# ---------- 服务端 ----------
FROM ${RUNTIME_IMAGE} AS server
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin vibechat \
    && mkdir -p /data \
    && chown vibechat:vibechat /data
COPY --from=server-build /vibechat-server /usr/local/bin/vibechat-server
USER vibechat
# 数据库、上传的文件、桌面端安装包、没有配置发信服务时写下的邮件，都在 /data 下
ENV LISTEN_ADDR=0.0.0.0:3488 \
    DATABASE_URL=sqlite:///data/db/vibechat.db?mode=rwc \
    FILES_DIR=/data/files
VOLUME /data
EXPOSE 3488
CMD ["vibechat-server"]

# ---------- 网页和入口 ----------
FROM ${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /src/client/apps/web/dist /srv/vibechat
