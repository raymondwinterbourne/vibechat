// 更新说明：每次给用户带来看得到的变化，在这里加一条，新的放在最前面（计划文档第 5 章）。
//
// 写法：给用户看的话，一条一句，不写技术细节；中文和英文各一份。
// 只和管理员有关的加 `adminOnly: true`。编号是日期，同一天有几次时加序号（`2026-10-15.2`）。

import type { Release } from '@vibechat/core'

export const RELEASE_NOTES: readonly Release[] = [
  {
    id: '2026-11-18',
    items: [
      {
        zh: '修正：在群通话里刷新或关掉页面，有时别人那里一直显示你还在通话里；现在会马上显示你已经离开',
        en: 'Fixed: after you reloaded or closed the page during a group call, others sometimes kept seeing you in the call; they now see at once that you left',
      },
      {
        zh: '支持的浏览器改为最新版的 Chrome 和 Safari（电脑和手机上都可以），不再支持 Firefox',
        en: 'Supported browsers are now the latest Chrome and Safari, on computers and phones; Firefox is no longer supported',
      },
    ],
  },
  {
    id: '2026-11-17.2',
    items: [
      {
        zh: '手机横过来看通话时，画面占满整个高度，人和按钮排到右边；iPhone 上看共享的屏幕也能"全屏"了：画面铺满整个页面，照样可以双指放大',
        en: 'With your phone turned sideways, a call now gives the picture the full height, with people and buttons along the right; on iPhone a shared screen can now go "full screen": it fills the whole page and can still be pinched to zoom',
      },
    ],
  },
  {
    id: '2026-11-17',
    items: [
      {
        zh: '群通话里可以共享屏幕了：语音通话、视频通话里，电脑上都多了"共享屏幕"。同一时间一个人共享，别人那里他的屏幕自动占大块，可以全屏、放大、按原始大小看，也可以点别人把人放大；手机上能看、能放大，不能共享。共享时自己的摄像头照常开着',
        en: 'You can now share your screen in group calls: in voice and video calls alike, there is a "Share screen" button on a computer. One person shares at a time; for everyone else the screen takes the big tile, and can be viewed full screen, zoomed, or at actual size, or you can click a person to enlarge them instead. Phones can watch and zoom but not share. Your camera stays on while you share',
      },
      {
        zh: '管理员可以在系统设置里调群通话中共享屏幕的码率，页面上会算出共享时对服务器带宽的影响',
        en: 'The administrator can set the bitrate of screens shared in group calls; the page works out what sharing costs the server in bandwidth',
        adminOnly: true,
      },
    ],
  },
  {
    id: '2026-11-16',
    items: [
      {
        zh: '群里可以视频通话了：群聊标题栏上"语音通话"旁边多了"视频通话"。通话里每个人一格，没开摄像头的显示头像；点一格可以放大，再点一次回到格子；随时可以关掉、再打开自己的摄像头，手机上可以翻转。缩小后是一个带画面的小窗，可以继续聊天。语音通话还是只有声音，想看画面请发起视频通话',
        en: 'Groups now have video calls: next to "Voice call" in the group\'s title bar there is "Video call". Everyone gets a tile, with a profile picture when their camera is off; click a tile to enlarge it, and again to go back to the grid. Turn your own camera off and on at any time, and flip it on a phone. Minimized, the call becomes a small window with a picture so you can keep chatting. Voice calls stay sound only; start a video call when you want pictures',
      },
      {
        zh: '系统设置里新增"群视频的画面"：可以调清楚的和小的两档画面的码率，页面上会算出按现在的数最多占用服务器多少出口带宽',
        en: 'New in System settings, "Group video pictures": set the bitrate of the clear and the small picture tier; the page works out how much of the server\'s outgoing bandwidth the numbers can use at most',
        adminOnly: true,
      },
    ],
  },
  {
    id: '2026-11-15',
    items: [
      {
        zh: '群里可以语音通话了：点群聊标题栏上的"语音通话"，选要邀请的人再发起；被邀请的人会响铃，没被邀请的群成员看到"通话进行中"也可以随时加入。通话中能看到谁在说话、谁静音了，可以再邀请别人，可以缩小后继续聊天；最后一个人离开时通话结束，群里留下一条通话记录',
        en: 'Groups now have voice calls: click "Voice call" in the group\'s title bar, pick who to invite, and start. The people you invite get a ring; other members see "Voice call in progress" and can join at any time. In the call you see who is speaking and who is muted, can invite more people, and can minimize it to keep chatting. The call ends when the last person leaves, and the group keeps a record of it',
      },
    ],
  },
  {
    id: '2026-10-23.3',
    items: [
      {
        zh: '设置里新增"登录设备"：看到自己正在哪几台设备上登录着，可以让不再用的、认不出来的设备退出登录',
        en: 'New in Settings, "Signed-in devices": see where you are signed in, and sign out devices you no longer use or don\'t recognize',
      },
    ],
  },
  {
    id: '2026-10-23.2',
    items: [
      {
        zh: '对方正在打字时，聊天标题旁边显示"对方正在输入…"；群里写明是谁在输入',
        en: 'When the other side is typing, "Typing…" shows next to the chat title; in a group it says who is typing',
      },
    ],
  },
  {
    id: '2026-10-23',
    items: [
      {
        zh: '自己发的文字消息、图片的说明可以编辑了：在消息的菜单里选"编辑"，电脑上也可以在输入框是空的时候按 ↑。改过的消息标着"已编辑"，所有人看到的都是新的内容',
        en: 'You can now edit your own text messages and picture captions: choose "Edit" in the message menu, or press ↑ in an empty message box on a computer. Edited messages are marked "Edited" and everyone sees the new text',
      },
      {
        zh: '管理员可以在系统设置里调编辑的时限（默认 24 小时），查看聊天内容时看得到修改前的每一版',
        en: 'The administrator can set how long messages stay editable (24 hours by default) and sees every earlier version when viewing a chat',
        adminOnly: true,
      },
    ],
  },
  {
    id: '2026-10-22.5',
    items: [
      {
        zh: '共享屏幕时，自己这边也能看到发出去的画面多大、多少码率、受什么限制',
        en: 'While sharing your screen, you can see the size and bitrate of the picture you send, and what is holding it back',
      },
    ],
  },
  {
    id: '2026-10-22.4',
    items: [
      {
        zh: '共享屏幕更清楚了：直连时画面更大、码率更高。管理员可以在系统设置里调通话画面的清晰度和码率',
        en: 'Shared screens are sharper: a bigger picture and a higher bitrate on a direct connection. The administrator can adjust call picture quality in the system settings',
      },
      {
        zh: '在电脑上看对方共享的屏幕时，可以用滚轮放大、拖动，或者点"原始大小"看清小字',
        en: 'Watching a shared screen on a computer, scroll to zoom, drag to move around, or choose "Actual size" to read small text',
      },
      {
        zh: '通话界面上的"直连"旁边显示收到的画面多大、多少码率',
        en: 'Next to "Direct" the call shows the size and bitrate of the picture coming in',
      },
    ],
  },
  {
    id: '2026-10-22.3',
    items: [
      {
        zh: '桌面客户端 0.4.0 可以共享屏幕了；旧版本点"共享屏幕"时会提示更新',
        en: 'Desktop app 0.4.0 can share the screen; older versions ask you to update first',
      },
      {
        zh: '在手机上看对方共享的屏幕时，可以双指放大、拖动，双击放大或还原',
        en: 'Watching a shared screen on a phone, pinch to zoom, drag to move around, and double-tap to zoom in or back out',
      },
      {
        zh: '通话界面上用小字标出这通电话是直连还是经中转',
        en: 'A small label in the call shows whether it is connected directly or through the relay',
      },
    ],
  },
  {
    id: '2026-10-22.2',
    items: [
      {
        zh: '语音或视频通话中，在电脑的浏览器里可以共享屏幕给对方看：点通话界面上的"共享屏幕"。对方在电脑或手机上都能看',
        en: 'During a voice or video call, you can share your screen from a computer browser: tap "Share screen" in the call. The other side can watch on a computer or a phone',
      },
    ],
  },
  {
    id: '2026-10-22',
    items: [
      {
        zh: '常用的会话可以置顶：在会话列表里右键或长按，或者用会话标题栏的"更多"菜单。在一台设备上置顶，其他设备也一样',
        en: 'Pin the chats you use most to the top: right-click or long-press a chat in the list, or use the "More" menu at the top of a chat. Pins follow you to your other devices',
      },
      {
        zh: '会话的"更多"菜单里可以看这个会话里的全部图片和文件，也能跳回聊天里那一条的位置',
        en: 'See every photo and file in a chat from its "More" menu, and jump back to where each one was sent',
      },
      {
        zh: '可以删除消息、清空聊天记录。只从你这里删除，对方仍然看得到；删了不能恢复',
        en: "Delete messages or clear a chat's history. They are removed only for you; the others can still see them, and this can't be undone",
      },
    ],
  },
  {
    id: '2026-10-16',
    items: [
      {
        zh: '视频通话中，手机上可以翻转前后摄像头',
        en: 'During a video call on a phone, you can flip between the front and back camera',
      },
      {
        zh: '桌面客户端 0.3.0 可以视频通话了；旧版本点视频通话时会提示更新',
        en: 'Desktop app 0.3.0 supports video calls; older versions ask you to update first',
      },
    ],
  },
  {
    id: '2026-10-15.4',
    items: [
      {
        zh: '可以和好友视频通话了：在单聊里点标题栏的摄像机按钮。通话中可以关掉、打开摄像头；视频来电也可以只用语音接听',
        en: 'Video calls with friends: tap the camera button at the top of a one-to-one chat. Turn your camera off and on during the call, or answer a video call with voice only',
      },
    ],
  },
  {
    id: '2026-10-15.3',
    items: [
      {
        zh: '在桌面客户端里下载新版本时显示下载进度，下完会提示保存和安装',
        en: 'Downloading a new version inside the desktop app now shows its progress, and tells you when to save and install it',
      },
    ],
  },
  {
    id: '2026-10-15.2',
    items: [
      {
        zh: '可以和好友语音通话了：在单聊里点标题栏的电话按钮。通话中可以缩小，继续看消息、发消息；通话结束后会话里留一条通话记录',
        en: 'Voice calls with friends: tap the phone button at the top of a one-to-one chat. Minimize the call to keep chatting; a record of the call stays in the chat',
      },
      {
        zh: '来电会响铃；页面不在前台时弹出系统通知，桌面客户端会把窗口带到前面。没接到的电话显示为"未接来电"',
        en: 'Incoming calls ring; when the page is in the background you get a notification, and the desktop app comes to the front. Calls you miss show as "Missed call"',
      },
    ],
  },
  {
    id: '2026-10-15',
    items: [
      {
        zh: '多选消息之后可以"合并转发"，对方收到一条聊天记录，点开能看到每一条是谁说的；聊天记录里的内容也能搜到',
        en: 'Select several messages and "Merge and forward" them as one chat history; it shows who said what, and its content can be searched',
      },
      { zh: '语音消息可以转发了', en: 'Voice messages can now be forwarded' },
      {
        zh: '群主可以设置最多 3 名管理员；群主和管理员可以禁言成员、开启全员禁言和入群审批',
        en: 'Group owners can appoint up to 3 admins; owners and admins can mute members, mute everyone, and approve new members',
      },
      {
        zh: '可以设置自己在群里的昵称（群信息里的"我在本群的昵称"）',
        en: 'Set your own name in a group under "My name in this group" in group info',
      },
      {
        zh: '通讯录按首字母分组，右侧有字母索引',
        en: 'Contacts are grouped by initial, with a letter index on the side',
      },
      {
        zh: '系统更新后会提示刷新，刷新后在这里告诉你更新了什么；设置的"关于"里可以随时翻看',
        en: 'After an update you are asked to reload, and then told what changed; see it any time under About in Settings',
      },
    ],
  },
]
