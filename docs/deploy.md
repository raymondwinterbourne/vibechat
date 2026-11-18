# 部署 VibeChat

[English](deploy.en.md)

这份说明讲怎么在一台自己的服务器上部署 VibeChat。部署用到的文件都在仓库的 `deploy/` 目录：

| 文件 | 内容 |
| --- | --- |
| `compose.yaml` | 要启动的几个容器 |
| `env.example` | 配置的样例，复制成 `.env` 再填 |
| `Dockerfile` | 服务端和网页的镜像，在服务器上构建 |
| `Caddyfile` | 对外的唯一入口：HTTPS、网页、把请求转给服务端 |
| `turnserver.conf`、`livekit.yaml` | 通话用的两个服务的配置 |

## 1. 先选一档

| | 第一档：只有公网 IP | 第二档：有域名，用 HTTPS |
| --- | --- | --- |
| 文字、图片、文件、群聊、管理后台 | 能用 | 能用 |
| 语音消息、语音和视频通话、共享屏幕 | 不能用 | 能用（要另外启动通话的服务，见第 5 节） |
| 浏览器通知 | 不能用 | 能用 |
| 桌面客户端 | 不能用 | 能用 |
| 需要准备 | 一台有公网 IP 的服务器 | 再加一个域名，解析到这台服务器 |

为什么只有 IP 时有这么多用不了：浏览器只在 HTTPS 的网页里允许用麦克风、摄像头、共享屏幕和通知，而 HTTPS 的证书一般要有域名才能申请。桌面客户端也只连 HTTPS 的服务器。

先用第一档试起来，以后有了域名再换成第二档，数据都在，不用重来。

## 2. 准备

**服务器**

- Linux，能装 Docker。2 核、2 GB 内存够几十个人用；要通话的话，带宽是主要的限制（第 5 节）。
- 装好 Docker 和 Compose 插件（`docker compose version` 要是 2.20 或更新的版本）。
- 构建镜像时要能从网上下载：Docker Hub 上的基础镜像、Rust 和 npm 的依赖。

**防火墙**（云服务器在控制台的"安全组"里设）放开：

| 端口 | 用途 | 哪一档要 |
| --- | --- | --- |
| TCP 80 | 网页；第二档里也用来申请证书 | 都要 |
| TCP 443、UDP 443 | HTTPS 的网页 | 第二档 |
| UDP 3478、TCP 3478 | 一对一通话的中转服务 | 第二档，要通话时 |
| UDP 49160–49260 | 中转服务转发声音和画面用的端口 | 第二档，要通话时 |
| TCP 7881、UDP 7882 | 群通话的声音和画面 | 第二档，要通话时 |

其他端口都不要对外开放。

**域名**（第二档）：添加一条 A 记录，例如 `chat.example.com`，指向服务器的公网 IP。等它生效（`ping chat.example.com` 能看到服务器的 IP）再往下做，否则申请不到证书。

## 3. 取代码，写配置

```bash
git clone https://github.com/raymondwinterbourne/vibechat.git
cd vibechat/deploy
cp env.example .env
```

用编辑器打开 `.env`，填"必填"那一段：

| 项 | 第一档（只有 IP） | 第二档（有域名） |
| --- | --- | --- |
| `SITE` | `:80` | 你的域名，例如 `chat.example.com` |
| `PUBLIC_URL` | `http://` 加服务器的 IP，例如 `http://203.0.113.10` | `https://` 加域名，例如 `https://chat.example.com` |
| `ADMIN_EMAIL` | 管理员的邮箱 | 同左 |
| `ADMIN_INITIAL_PASSWORD` | 管理员的初始密码，第一次登录后必须改 | 同左 |

`.env` 里有密码，不要提交到 git、不要发给别人。

## 4. 启动

在 `deploy` 目录下：

```bash
docker compose up -d --build
```

第一次要下载和编译，一般要十几分钟。之后看一下状态：

```bash
docker compose ps
docker compose logs app --tail 20
```

`app`、`web` 两个容器都是 `running`，服务端的日志里有 `listening on 0.0.0.0:3488`，就启动好了。在浏览器里打开 `PUBLIC_URL` 写的那个地址。

**第一次登录**：ID 是 `admin`，密码是 `ADMIN_INITIAL_PASSWORD`。登录后先改密码，然后在"管理 → 邀请码"里生成邀请码，交给要加入的人，他们凭邀请码注册。

第二档第一次打开时，Caddy 要先申请证书，可能要等十几秒。打不开的话看 `docker compose logs web`。

## 5. 通话（第二档，可选）

通话要两个服务：一对一通话的中转服务（coturn），群通话的媒体转发服务（LiveKit）。都跑在这台服务器上。

1. 确认防火墙已经放开第 2 节表格里"要通话时"的那几行。
2. 生成两个密钥：

   ```bash
   openssl rand -hex 32
   openssl rand -hex 32
   ```

3. 在 `.env` 的"通话"一段里填：
   - `PUBLIC_IP`：服务器的公网 IP。
   - `PRIVATE_IP`：有的云服务器上，机器本身只有内网地址，公网地址是在外面映射进来的（`ip addr` 里看不到公网 IP）。这种情况填机器的内网地址；否则空着。
   - `TURN_SECRET`、`LIVEKIT_API_SECRET`：上一步生成的两串，一项一串。
4. 启动（会顺带重建服务端，让它知道通话服务的地址）：

   ```bash
   docker compose --profile calls up -d --build
   ```

5. 验证：登录后打开 `https://你的域名/call-check` 和 `https://你的域名/group-call-check`，按页面上的提示检查。都通过后，找另一个人试一次通话。

以后每条 `docker compose` 命令都要带上 `--profile calls`，否则这两个服务不会跟着启动、更新。

**带宽**：一对一通话能直连时不经过服务器；走中转时每一路占几百 kbps 到几 Mbps。群通话的声音和画面全部经过服务器：每个人收到其他所有人的。管理员可以在"管理 → 系统设置"里调画面的码率和群通话的人数上限，页面上会算出对服务器带宽的影响。

## 6. 可选的设置

**发信**：管理员忘了密码时，靠邮件找回；修改管理员的邮箱也要邮件确认。在 `.env` 里填 `SMTP_URL`（例如 `smtps://用户名:密码@smtp.example.com:465`）和 `MAIL_FROM`（发件人的地址）。不填时，邮件写在数据卷的 `mail` 目录里，可以这样看：

```bash
docker compose exec app ls /data/mail
```

**PostgreSQL**：默认用 SQLite，数据在一个文件里，几百人用没问题。要用 PostgreSQL 时，在 `.env` 里填 `POSTGRES_PASSWORD`，把 `DATABASE_URL` 那一行的注释去掉、填上同一个密码，然后每条命令都带上 `--profile postgres`。已经用 SQLite 存了数据之后再换，原来的数据不会自动搬过去。

**桌面客户端（macOS）**：要第二档。打包时用 `VC_SERVER_URL=https://你的域名` 说明连哪个服务器，见 `client/apps/desktop/README.md`。打出来的 `.dmg` 放进数据卷的 `desktop` 目录，用户就能在"设置 → 关于"里下载：

```bash
docker compose exec app mkdir -p /data/desktop
docker compose cp VibeChat-0.1.0-arm64.dmg app:/data/desktop/
```

## 7. 日常

**更新到新版本**：

```bash
cd vibechat
git pull
cd deploy
docker compose up -d --build       # 用了通话、PostgreSQL 的，带上对应的 --profile
```

数据库的结构有变化时，服务端启动时自己升级。已经打开的页面会提示"系统已更新，点这里刷新"。

自己在电脑上改代码、想一条命令推到服务器并重新部署的，可以用 `scripts/deploy`：用法见它开头的说明，配置照 `scripts/deploy.conf.example` 写。

**备份**：所有数据都在 Docker 的数据卷里，主要是 `vibechat-deploy_data`（数据库、上传的文件）。最简单的做法是停掉服务端、把这个卷打包：

```bash
docker compose stop app
docker run --rm -v vibechat-deploy_data:/data -v "$PWD":/backup debian:trixie-slim \
  tar czf /backup/vibechat-data-$(date +%F).tar.gz -C /data .
docker compose start app
```

用 PostgreSQL 的，另外用 `pg_dump` 备份数据库。

**日志**：

```bash
docker compose logs app --tail 100      # 服务端
docker compose logs web --tail 100      # 网页入口，证书的问题看这里
```

## 8. 出问题时

| 现象 | 看哪里 |
| --- | --- |
| 打不开网页 | 防火墙有没有放开 80（第二档还有 443）；`docker compose ps` 里两个容器是不是都在运行 |
| 第二档申请不到证书 | 域名是不是已经解析到这台服务器；80 端口要能从外面访问；`docker compose logs web` |
| 能打开，但登录后提示连不上 | 浏览器地址栏里的地址要和 `PUBLIC_URL` 完全一样（`http`/`https`、有没有 `www`、端口） |
| 服务端起不来 | `docker compose logs app`：配置有问题时会写明是哪一项 |
| 通话一直在"连接中" | `/call-check`、`/group-call-check` 页面；防火墙的 UDP 端口；云服务器是不是要填 `PRIVATE_IP` |
| 很多人登录被提示"太频繁" | 网页入口的地址和 `compose.yaml` 里的 `TRUSTED_PROXIES` 不一致时，服务端会把所有人当成同一个地址来限速 |

Docker 的内部网络用了 `172.31.250.0/24` 这一段。和服务器上已有的网络冲突时，改 `compose.yaml` 最下面的网段，以及 `web` 的 `ipv4_address` 和 `app` 的 `TRUSTED_PROXIES`，三处一起改。
