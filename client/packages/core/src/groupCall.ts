// 群通话（F10）的接口调用。通话的状态在 groupCalls.ts 里，声音的连接在 room.ts 里。

import type { GroupCallJoined, GroupCallList, GroupCallView } from '@vibechat/protocol'
import { apiRequest } from './api'

interface Options {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

function post(body: unknown, options: Options = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  }
}

/**
 * 在这台设备上发起群通话，邀请这些人（他们的设备响铃）。我自己马上就在通话里。
 * `video`：发起的是视频通话，里面的人可以开摄像头；语音通话不行，之后也不能改（F11）。
 */
export function startGroupCall(
  conversationId: string,
  device: string,
  invite: string[],
  video: boolean,
  options?: Options,
): Promise<GroupCallJoined> {
  return apiRequest(
    '/api/group-calls',
    post({ conversation_id: conversationId, device, invite, video }, options),
  )
}

/** 在这台设备上加入。被没被邀请都可以。 */
export function joinGroupCall(
  id: string,
  device: string,
  options?: Options,
): Promise<GroupCallJoined> {
  return apiRequest(`/api/group-calls/${id}/join`, post({ device }, options))
}

/** 通话里的人再邀请几个人。 */
export function inviteToGroupCall(
  id: string,
  userIds: string[],
  options?: Options,
): Promise<GroupCallView> {
  return apiRequest(`/api/group-calls/${id}/invite`, post({ user_ids: userIds }, options))
}

/** 不理会邀请：我的设备都不再响。之后仍然可以加入。 */
export function declineGroupCall(id: string, options: Options = {}): Promise<GroupCallView> {
  return apiRequest(`/api/group-calls/${id}/decline`, { method: 'POST', ...options })
}

/** 离开。最后一个人离开时通话结束。 */
export function leaveGroupCall(
  id: string,
  device: string,
  options?: Options,
): Promise<GroupCallView> {
  return apiRequest(`/api/group-calls/${id}/leave`, post({ device }, options))
}

/**
 * 开始共享屏幕（F12）：先问服务端。同一时间只有一个人共享，已经有别人在共享时得到 `group_call_sharing`。
 */
export function shareGroupScreen(
  id: string,
  device: string,
  options?: Options,
): Promise<GroupCallView> {
  return apiRequest(`/api/group-calls/${id}/share`, post({ device }, options))
}

/** 停止共享屏幕。不是我在共享时什么都不变。 */
export function unshareGroupScreen(
  id: string,
  device: string,
  options?: Options,
): Promise<GroupCallView> {
  return apiRequest(`/api/group-calls/${id}/unshare`, post({ device }, options))
}

/** 我所在的群里正在进行的通话。 */
export function fetchGroupCalls(options: Options = {}): Promise<GroupCallList> {
  return apiRequest('/api/group-calls', options)
}
