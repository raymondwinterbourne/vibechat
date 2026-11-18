# VibeChat 桌面客户端（macOS）

一个 Mac 应用：打开就是聊天界面，功能和浏览器里的 Web 应用完全一样；关掉窗口它还在程序坞里，有新消息时图标上出现未读数、系统弹出通知。

界面不在应用里面。应用启动后加载的是服务器上的页面，和浏览器里是同一份，所以界面更新不需要重新安装。设计见 [桌面客户端设计文档](../../../docs/desktop-design.md)。

只支持 Apple 芯片（M 系列）的 Mac，macOS 13 或更新。

## 安装

1. 用 Mac 上的浏览器登录 VibeChat。会话列表顶部有一条"VibeChat 有 Mac 客户端了"的提示，点"下载"；提示已经关掉的话，点左侧导航栏底部"设置"上面的那个图标，或者到"设置"最下面的"关于"里下载。这些入口只在 Mac 的浏览器里出现。
2. 打开下载的 `VibeChat-x.y.z-arm64.dmg`，把 VibeChat 拖进旁边的"应用程序"。
3. 在"应用程序"里双击 VibeChat。

### 第一次打开会被系统拦下

系统会说无法验证这个应用。这是因为它没有经过 Apple 的公证（需要付费的开发者账号，现在没有），不是应用有问题。放行一次即可：

1. 在提示里点"完成"。
2. 打开"系统设置 → 隐私与安全性"，往下翻，找到关于 VibeChat 的那一行，点"仍要打开"。
3. 输入这台 Mac 的密码确认。

以后再打开就不会问了。

### 之后系统还会问两次

- 第一次收到消息时：是否允许 VibeChat 发通知。
- 第一次录语音时：是否允许 VibeChat 使用麦克风。

## 更新

绝大部分更新是界面的更新，不用动桌面端。

桌面端自己有新版本时，应用里"设置 → 关于"会出现"有新版本"和下载按钮。下载后：

1. 退出 VibeChat（`⌘Q`）。
2. 打开新下载的文件，把 VibeChat 拖进"应用程序"，选择"替换"。
3. 重新打开。第一次可能又要按上面的办法放行一次；系统也可能问一次是否允许它读取钥匙串里自己的那一项，选"始终允许"。

## 卸载

1. 退出 VibeChat，把"应用程序"里的 VibeChat 拖进废纸篓。
2. 删掉它的数据目录（登录状态、窗口的位置都在这里，里面没有聊天记录）：

   ```bash
   rm -rf ~/Library/Application\ Support/VibeChat
   ```

想清得更干净，还有两处很小的东西：`~/Library/Preferences/io.github.raymondwinterbourne.vibechat.plist`，以及"钥匙串访问"里名为 `VibeChat Safe Storage` 的一项。

## 常用操作

| 操作 | 结果 |
|---|---|
| 点窗口的关闭按钮，或 `⌘W` | 窗口藏起来，应用继续运行，照常收消息 |
| 点程序坞上的图标 | 窗口回来 |
| `⌘Q` | 真正退出。不会退出登录 |
| `⌘,` | 打开设置 |

---

## 开发

应用在容器里编译和打包，在 Mac 上签名、运行、检查。Mac 上不需要 Node，只用系统自带的工具。

```bash
# 容器里：编译并打出 out/VibeChat-darwin-arm64/VibeChat.app
docker exec -e VC_SERVER_URL=https://chat.example.com vibechat sh -c 'cd client && pnpm --filter @vibechat/desktop package'
```

以下都在 Mac 上，`client/apps/desktop` 目录里：

```bash
scripts/mac run --server=http://127.0.0.1:8780   # 签过名之后启动，连本机的开发环境
```

```bash
scripts/mac check    # 签名，然后自动检查，约一分钟。期间窗口会出现几次
```

```bash
scripts/mac dmg      # 签名，做成 out/VibeChat-x.y.z-arm64.dmg
```

```bash
scripts/mac publish <目录>   # 把安装包放到服务器存放安装包的目录里
```

`publish` 的目录可以在本机（例如开发环境的 `../../../data/desktop`），也可以在别的机器上（写成 `主机:目录`，走 ssh；主机的别名在某份 ssh 配置里时，用环境变量 `VC_SSH_CONFIG` 指向它）。放上去就生效，不用重启服务。

### 发一个新版本

1. 改 `package.json` 里的 `version`。
2. 容器里打包；Mac 上 `scripts/mac check`，再 `scripts/mac dmg`。
3. 照 [D1 任务清单](../../../docs/milestones/d1.md) 里的手工走查清单走一遍。
4. `scripts/mac publish …`。

### 连哪个服务器

打包时用环境变量 `VC_SERVER_URL` 说明这个应用连哪个服务器（必须是 https 的），它被写进应用里；代码里不写死任何地址。启动参数 `--server=…` 或环境变量 `VC_SERVER_URL` 可以临时换成别的，开发时连本机用 `--server=http://127.0.0.1:8780`。

### 代码在哪里

| 位置 | 内容 |
|---|---|
| `src/main/index.ts` | 把下面这些规则接到 Electron 上：窗口、菜单、程序坞、下载、权限 |
| `src/main/*.ts`（其余） | 规则本身，不依赖 Electron，各有单元测试：页面可以去哪里、页面发来的消息怎么检查、菜单有哪些项、窗口的位置怎么恢复、内容安全策略 |
| `src/preload.cts` | 预加载脚本：页面和主进程之间唯一的通道，只挂出五个接口 |
| `resources/offline/` | 连不上服务器时显示的页面 |
| `scripts/check/` | 对真应用的自动检查 |
| `assets/` | 图标。由 `scripts/icon.mjs` 生成，是占位的 |

页面这一边（未读数、通知、指令、版本提示）在 `client/packages/core/src/platform.ts` 和 `client/packages/ui` 里，测试在 `client/e2e/tests/desktop.spec.ts`。

### 测试

| 测什么 | 在哪里跑 |
|---|---|
| 主进程里的规则（单元测试） | 容器：`pnpm --filter @vibechat/desktop test` |
| 页面在桌面端里的表现（用一组假的桌面端接口，三种浏览器内核） | 容器：全量测试的一部分 |
| 真正的应用 | Mac：`scripts/mac check` |
| 只有人在场才看得到的 | Mac：手工走查 |
