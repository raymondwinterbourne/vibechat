# VibeChat 的开发镜像：Ubuntu，加上编译要用的 C 工具链、Rust、Node（pnpm 由 corepack 按
# client/package.json 里写的版本取）、watchexec。
#
# Rust、Node、watchexec 的安装包：dev/downloads/ 下有就直接用，没有才下载。网络不好时可以先手动下好
# 放进去，文件名保持原样（Apple 芯片的机器；Intel 的机器把 aarch64 换成 x86_64、arm64 换成 x64）：
#   rust-1.99.0-aarch64-unknown-linux-gnu.tar.xz        https://static.rust-lang.org/dist/
#   node-v22.23.3-linux-arm64.tar.xz                    https://nodejs.org/dist/v22.23.3/
#   watchexec-2.7.4-aarch64-unknown-linux-gnu.tar.xz    https://github.com/watchexec/watchexec/releases/tag/v2.7.4
# 也可以换成镜像站：
#   docker compose build --build-arg NODE_DIST=https://npmmirror.com/mirrors/node dev
FROM ubuntu:24.04

ARG RUST_VERSION=1.99.0
ARG NODE_VERSION=22.23.3
ARG WATCHEXEC_VERSION=2.7.4
ARG RUST_DIST=https://static.rust-lang.org
ARG NODE_DIST=https://nodejs.org/dist
ARG WATCHEXEC_DIST=https://github.com/watchexec/watchexec/releases/download

ARG DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8 \
    PATH=/opt/rust/bin:/home/ubuntu/.cargo/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config cmake ca-certificates curl git xz-utils unzip tzdata procps less sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Rust、Node、watchexec（改了 Rust 代码自动重启后端）都用官方打好的包。dev/downloads/ 只在这一步临时挂进来，不会留在镜像里
RUN --mount=type=bind,source=downloads,target=/tmp/downloads \
    set -eux; \
    case "$(uname -m)" in \
      x86_64) rust=x86_64-unknown-linux-gnu; node=x64 ;; \
      aarch64) rust=aarch64-unknown-linux-gnu; node=arm64 ;; \
      *) echo "unsupported architecture: $(uname -m)"; exit 1 ;; \
    esac; \
    fetch() { if [ -f "/tmp/downloads/$2" ]; then cat "/tmp/downloads/$2"; else curl -fsSL "$1/$2"; fi; }; \
    fetch "$RUST_DIST/dist" "rust-$RUST_VERSION-$rust.tar.xz" | tar -xJ -C /tmp; \
    "/tmp/rust-$RUST_VERSION-$rust/install.sh" --prefix=/opt/rust --components=rustc,cargo,rust-std-$rust,clippy-preview,rustfmt-preview; \
    rm -rf "/tmp/rust-$RUST_VERSION-$rust"; \
    mkdir -p /opt/node; \
    fetch "$NODE_DIST/v$NODE_VERSION" "node-v$NODE_VERSION-linux-$node.tar.xz" | tar -xJ -C /opt/node --strip-components=1; \
    corepack enable --install-directory /opt/node/bin; \
    fetch "$WATCHEXEC_DIST/v$WATCHEXEC_VERSION" "watchexec-$WATCHEXEC_VERSION-$rust.tar.xz" \
      | tar -xJ -C /usr/local/bin --strip-components=1 "watchexec-$WATCHEXEC_VERSION-$rust/watchexec"

# 基础镜像自带 ubuntu 用户（UID 1000），开发命令都以它运行。
# 编译产物和 cargo 的下载缓存放在命名卷里，先把挂载点建好、给它
RUN mkdir -p /vibechat/server/target /home/ubuntu/.cargo \
    && chown -R ubuntu:ubuntu /vibechat /home/ubuntu

USER ubuntu

WORKDIR /vibechat
CMD ["sleep", "infinity"]
