import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { fileUrl, groupRole, memberName } from '@vibechat/core'
import type { ConversationView, MemberView } from '@vibechat/protocol'
import { ChevronLeft, ImagePlus, UserPlus, X } from 'lucide-react'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { Switch } from '../../components/Switch'
import { useErrorMessage } from '../../errors'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { ConversationAvatar } from './ConversationAvatar'
import { GroupNameEditor } from './GroupNameEditor'
import { GroupNicknameRow } from './GroupNicknameRow'
import { Invite } from './InviteDialog'
import { JoinRequests } from './JoinRequests'
import { Member } from './MemberDialog'
import { NoticeView } from './NoticeDialog'
import { displayName } from './text'

type Open =
  | { kind: 'avatar' | 'invite' | 'leave' | 'dissolve' | 'notice' | 'requests' }
  | { kind: 'member'; userId: string }
  | null

interface GroupPanelProps {
  conversation: ConversationView
  members: readonly MemberView[] | undefined
  onClose: () => void
  /** 打开这个群的图片和文件一览。 */
  onOpenMedia: () => void
  /** 清空这个群的聊天记录（只对我），确认之后。 */
  onClearChat: () => void
}

/** 群信息：电脑上是会话右侧的面板，手机上盖住整个会话。 */
export function GroupPanel({
  conversation,
  members,
  onClose,
  onOpenMedia,
  onClearChat,
}: GroupPanelProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const me = useMe()
  const store = useChatStore()
  const [open, setOpen] = useState<Open>(null)
  const [renaming, setRenaming] = useState(false)
  const avatarInput = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLElement>(null)
  // 面板出现时焦点进到里面，用键盘的人可以接着往下走
  useEffect(() => {
    panel.current?.focus()
  }, [])
  const close = () => setOpen(null)
  const failed = (error: unknown) => toast.error(errorMessage(error))

  const { id, group } = conversation
  // 不是好友的成员改了昵称或头像不会有推送：每次打开面板都取一遍最新的
  useEffect(() => {
    store.loadMembers(id).catch(() => {})
  }, [store, id])

  const upload = useMutation({
    mutationFn: (file: File) => store.setGroupAvatar(id, file),
    onSuccess: () => toast.success(t('group.avatarUpdated')),
    onError: failed,
  })

  // 退出、解散、移除之后这个面板可能已经不在了，先关掉对话框再做后面的事
  const leave = useMutation({
    mutationFn: () => store.leave(id),
    onSuccess: () => navigate({ to: '/chats' }),
    onError: (error) => {
      failed(error)
      close()
    },
  })

  const dissolve = useMutation({
    mutationFn: () => store.dissolve(id),
    onSuccess: close,
    onError: (error) => {
      failed(error)
      close()
    },
  })

  const mute = useMutation({
    mutationFn: (muted: boolean) => store.mute(id, muted),
    onError: failed,
  })

  const approval = useMutation({
    mutationFn: (enabled: boolean) => store.setJoinApproval(id, enabled),
    onError: failed,
  })

  const muteAll = useMutation({
    mutationFn: (muted: boolean) => store.setAllMuted(id, muted),
    onError: failed,
  })

  const hide = useMutation({
    mutationFn: () => store.hide(id),
    onSuccess: () => navigate({ to: '/chats' }),
    onError: failed,
  })

  if (!group) return null

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // 清空选择，这样再次选同一个文件也会触发
    event.target.value = ''
    if (file) upload.mutate(file)
  }

  const present = (members ?? []).filter((member) => member.active)
  // 群主排在最前面，然后是管理员，其余按入群的先后
  const rank = (member: MemberView) => (member.is_owner ? 0 : member.is_admin ? 1 : 2)
  const listed = [...present].sort((a, b) => rank(a) - rank(b) || a.joined_seq - b.joined_seq)
  const gone = group.left || group.dissolved
  const role = groupRole(conversation, me.id)
  const iAmOwner = role === 'owner'
  // 群主和管理员：改群名、换头像、编辑公告
  const iManage = role !== 'member'
  // 群里只剩群主一个人时，他可以直接退
  const canLeave = !gone && (!iAmOwner || group.member_count === 1)

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={t('group.title')}
      data-testid="group-panel"
      className="absolute inset-0 z-10 flex flex-col bg-bg md:static md:z-auto md:w-[280px] md:flex-none md:border-border md:border-l"
    >
      <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b pr-2 pl-4 max-md:pl-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.close')}
          className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:hidden"
        >
          <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate font-medium text-[17px] md:text-[15px]">
          {t('group.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.close')}
          title={t('group.close')}
          className="hidden size-9 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:grid"
        >
          <X size={20} strokeWidth={1.5} aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex items-center gap-3 border-border border-b p-4">
          {/* 点头像看大图；群主在那里更换 */}
          <button
            type="button"
            onClick={() => setOpen({ kind: 'avatar' })}
            aria-label={t('group.viewAvatar')}
            title={t('group.viewAvatar')}
            data-testid="group-avatar"
            className="flex-none rounded-card transition-opacity duration-150 hover:opacity-80"
          >
            <ConversationAvatar conversation={conversation} size={56} />
          </button>
          <div className="min-w-0 flex-1">
            {iManage && renaming ? (
              <GroupNameEditor
                conversation={conversation}
                onDone={() => setRenaming(false)}
                testId="group-name-input"
                className="h-9 w-full"
              />
            ) : (
              <p data-testid="group-name" className="break-words font-medium">
                {iManage ? (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    title={t('group.rename')}
                    className="-mx-1 rounded-control px-1 text-left transition-colors duration-150 hover:bg-hover max-md:min-h-11"
                  >
                    {displayName(conversation, t)}
                  </button>
                ) : (
                  displayName(conversation, t)
                )}
              </p>
            )}
            <p className="text-[12px] text-fg-3">
              {group.dissolved
                ? t('group.dissolvedNotice')
                : group.left
                  ? t('group.leftNotice')
                  : t('group.memberCount', { count: group.member_count })}
            </p>
          </div>
        </div>

        {/* 群公告：开头的几行，点开看全文；群主在那里编辑。已经离开的人看不到 */}
        {!group.left && (group.notice || iManage) && (
          <button
            type="button"
            data-testid="group-notice"
            onClick={() => {
              setOpen({ kind: 'notice' })
              store.markNoticeSeen(id)
            }}
            className="flex w-full flex-col items-start gap-1 border-border border-b px-4 py-3 text-left hover:bg-hover"
          >
            <span className="text-[12px] text-fg-2">{t('groupNotice.title')}</span>
            <span
              data-testid="group-notice-text"
              className={`line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                group.notice ? '' : 'text-accent-fg'
              }`}
            >
              {group.notice?.text ?? t('groupNotice.publish')}
            </span>
          </button>
        )}

        {/* 已经不在群里的人，只能看到自己离开时的名单，不再列出来 */}
        {!group.left && (
          <section className="border-border border-b py-2">
            <h3 className="px-4 py-2 text-[12px] text-fg-2">
              {t('group.members', { count: group.member_count, max: group.max_members })}
            </h3>
            {!gone && (
              <button
                type="button"
                onClick={() => setOpen({ kind: 'invite' })}
                className="flex h-12 w-full items-center gap-3 px-4 text-left text-accent-fg hover:bg-hover"
              >
                <span className="grid size-8 flex-none place-items-center rounded-card border border-border border-dashed">
                  <UserPlus size={16} strokeWidth={1.5} aria-hidden />
                </span>
                {t('group.invite')}
              </button>
            )}
            <ul data-testid="member-list">
              {listed.map((member) => (
                <li key={member.user.id}>
                  <button
                    type="button"
                    data-testid="member"
                    onClick={() => setOpen({ kind: 'member', userId: member.user.id })}
                    className="flex h-12 w-full items-center gap-3 px-4 text-left hover:bg-hover"
                  >
                    <Avatar user={member.user} size={32} />
                    <span data-testid="member-name" className="min-w-0 flex-1 truncate">
                      {memberName(member)}
                    </span>
                    {member.user.id === me.id && (
                      <span className="flex-none text-[12px] text-fg-3">{t('group.me')}</span>
                    )}
                    {member.is_owner && (
                      <span
                        data-testid="owner-tag"
                        className="flex-none rounded-full bg-surface px-2 py-0.5 text-[11px] text-fg-2"
                      >
                        {t('group.owner')}
                      </span>
                    )}
                    {member.is_admin && (
                      <span
                        data-testid="admin-tag"
                        className="flex-none rounded-full bg-surface px-2 py-0.5 text-[11px] text-fg-2"
                      >
                        {t('group.admin')}
                      </span>
                    )}
                    {member.muted_until !== null && member.muted_until > Date.now() && (
                      <span
                        data-testid="muted-tag"
                        className="flex-none rounded-full bg-surface px-2 py-0.5 text-[11px] text-danger"
                      >
                        {t('silence.tag')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!gone && (
          <GroupNicknameRow
            conversation={conversation}
            current={present.find((member) => member.user.id === me.id)?.group_nickname ?? null}
            fallback={me.nickname}
          />
        )}
        {iManage && (
          <div className="flex items-center justify-between gap-3 border-border border-b px-4 py-2">
            <span className="min-w-0">
              <span className="block">{t('joinRequests.approval')}</span>
              <span className="block text-[12px] text-fg-3">{t('joinRequests.approvalHint')}</span>
            </span>
            <Switch
              label={t('joinRequests.approval')}
              checked={group.join_approval}
              onChange={approval.mutate}
            />
          </div>
        )}
        {/* 入群申请：群主和管理员处理；开着审批时普通成员看自己发出的 */}
        {!gone && (iManage || group.join_approval) && (
          <button
            type="button"
            data-testid="open-join-requests"
            onClick={() => setOpen({ kind: 'requests' })}
            className="flex min-h-12 w-full items-center gap-3 border-border border-b px-4 py-2 text-left hover:bg-hover"
          >
            <span className="min-w-0 flex-1">
              {iManage ? t('joinRequests.open') : t('joinRequests.mine')}
            </span>
            {group.pending_requests > 0 && (
              <span
                data-testid="pending-requests"
                className="flex-none rounded-full bg-danger px-2 py-0.5 text-[11px] text-on-accent"
              >
                {t('joinRequests.pendingCount', { count: group.pending_requests })}
              </span>
            )}
          </button>
        )}
        {iManage && (
          <div className="flex items-center justify-between gap-3 border-border border-b px-4 py-2">
            <span className="min-w-0">
              <span className="block">{t('silence.all')}</span>
              <span className="block text-[12px] text-fg-3">{t('silence.allHint')}</span>
            </span>
            <Switch label={t('silence.all')} checked={group.all_muted} onChange={muteAll.mutate} />
          </div>
        )}
        <button
          type="button"
          onClick={onOpenMedia}
          data-testid="group-media"
          className="flex min-h-11 items-center justify-between gap-3 border-border border-b px-4 py-2 text-left transition-colors duration-150 hover:bg-hover"
        >
          <span>{t('media.title')}</span>
          <span aria-hidden className="text-fg-3">
            ›
          </span>
        </button>
        <div className="flex items-center justify-between gap-3 border-border border-b px-4 py-2">
          <span>{t('mute.on')}</span>
          <Switch label={t('mute.on')} checked={conversation.muted} onChange={mute.mutate} />
        </div>
        <button
          type="button"
          onClick={onClearChat}
          data-testid="group-clear"
          className="flex min-h-11 items-center border-border border-b px-4 py-2 text-left text-danger transition-colors duration-150 hover:bg-hover"
        >
          {t('clear.title')}
        </button>

        <div className="flex flex-col items-start gap-2 p-4">
          {iAmOwner && group.member_count > 1 && (
            <p className="text-[12px] text-fg-3">{t('group.ownerLeaveHint')}</p>
          )}
          {canLeave && (
            <Button variant="danger" onClick={() => setOpen({ kind: 'leave' })}>
              {t('group.leave')}
            </Button>
          )}
          {iAmOwner && (
            <Button variant="danger" onClick={() => setOpen({ kind: 'dissolve' })}>
              {t('group.dissolve')}
            </Button>
          )}
          {gone && (
            <Button onClick={() => hide.mutate()} disabled={hide.isPending}>
              {t('group.hide')}
            </Button>
          )}
        </div>
      </div>

      <Dialog
        open={open?.kind === 'avatar'}
        onOpenChange={(next) => !next && close()}
        title={t('group.avatar')}
      >
        <div className="flex flex-col items-center gap-4">
          {group.avatar_file_id ? (
            <img
              src={fileUrl(group.avatar_file_id)}
              alt=""
              data-testid="group-avatar-large"
              className="aspect-square w-full max-w-[320px] rounded-card bg-surface object-cover"
            />
          ) : (
            <ConversationAvatar conversation={conversation} size={200} />
          )}
          {iManage && (
            <>
              <Button onClick={() => avatarInput.current?.click()} disabled={upload.isPending}>
                <ImagePlus size={16} strokeWidth={1.5} aria-hidden />
                {t('group.changeAvatar')}
              </Button>
              <input
                ref={avatarInput}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={onPick}
                data-testid="group-avatar-input"
                className="hidden"
              />
            </>
          )}
        </div>
      </Dialog>
      <Dialog
        open={open?.kind === 'notice'}
        onOpenChange={(next) => !next && close()}
        title={t('groupNotice.title')}
      >
        <NoticeView conversation={conversation} canEdit={iManage} onClose={close} />
      </Dialog>
      <Dialog
        open={open?.kind === 'requests'}
        onOpenChange={(next) => !next && close()}
        title={iManage ? t('joinRequests.title') : t('joinRequests.mine')}
      >
        <JoinRequests conversation={conversation} />
      </Dialog>
      <Dialog
        open={open?.kind === 'invite'}
        onOpenChange={(next) => !next && close()}
        title={t('invite.title')}
      >
        <Invite conversation={conversation} members={members ?? []} onClose={close} />
      </Dialog>
      <Dialog
        open={open?.kind === 'member'}
        onOpenChange={(next) => !next && close()}
        title={t('member.title')}
      >
        {open?.kind === 'member' && (
          <Member conversation={conversation} userId={open.userId} onClose={close} />
        )}
      </Dialog>
      <Dialog
        open={open?.kind === 'leave'}
        onOpenChange={(next) => !next && close()}
        title={t('group.leaveTitle')}
      >
        <p className="text-fg-2">{t('group.leaveExplain')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {tCommon('actions.cancel')}
          </Button>
          <Button variant="danger" onClick={() => leave.mutate()} disabled={leave.isPending}>
            {t('group.leave')}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={open?.kind === 'dissolve'}
        onOpenChange={(next) => !next && close()}
        title={t('group.dissolveTitle')}
      >
        <p className="text-fg-2">{t('group.dissolveExplain')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {tCommon('actions.cancel')}
          </Button>
          <Button variant="danger" onClick={() => dissolve.mutate()} disabled={dissolve.isPending}>
            {t('group.dissolve')}
          </Button>
        </div>
      </Dialog>
    </aside>
  )
}
