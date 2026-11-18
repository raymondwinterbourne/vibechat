// 群通话里选人（F10）：发起时选要邀请哪些人（默认全选），通话中再邀请还不在通话里的人。
// 选中的人的设备会响铃；没选中的人不响，但只要通话还在，随时可以自己加入。

import { memberName } from '@vibechat/core'
import { Check } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, useMembers } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { useMe } from '../../session'

interface GroupCallPickerProps {
  open: boolean
  conversationId: string
  /** 发起通话，还是通话中再邀请。 */
  mode: 'start' | 'invite'
  /** 发起的是视频通话：标题写明。 */
  video?: boolean
  /** 不用列出来的人：已经在通话里的。 */
  exclude?: readonly string[]
  /** 通话最多几个人。选的人比它多时说明"先到先得"。不知道时不说。 */
  limit?: number
  onConfirm: (userIds: string[]) => void
  onClose: () => void
}

export function GroupCallPicker({
  open,
  conversationId,
  mode,
  video = false,
  exclude,
  limit,
  onConfirm,
  onClose,
}: GroupCallPickerProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const me = useMe()
  const store = useChatStore()
  const members = useMembers(conversationId)

  useEffect(() => {
    if (open) store.loadMembers(conversationId).catch(() => {})
  }, [open, conversationId, store])

  // 还在群里的人，除了我自己和不用列的人
  const candidates = useMemo(
    () =>
      (members ?? []).filter(
        (member) =>
          member.active && member.user.id !== me.id && !(exclude ?? []).includes(member.user.id),
      ),
    [members, me.id, exclude],
  )
  const ids = candidates.map((member) => member.user.id).join(',')

  // 发起时默认全选；再邀请时默认一个都不选，免得把所有人再吵一遍
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!open) return
    setPicked(new Set(mode === 'start' && ids ? ids.split(',') : []))
  }, [open, mode, ids])

  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  const all = candidates.length > 0 && picked.size === candidates.length
  const chosen = candidates.filter((member) => picked.has(member.user.id))
  // 发起的人自己也占一个位置
  const overLimit = mode === 'start' && limit !== undefined && chosen.length + 1 > limit

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={
        mode === 'invite'
          ? t('groupCall.picker.inviteTitle')
          : video
            ? t('groupCall.picker.titleVideo')
            : t('groupCall.picker.title')
      }
      large
    >
      <div data-testid="group-call-picker" className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="text-[13px] text-fg-2">
          {t('groupCall.picker.hint')}
          {overLimit && ` ${t('groupCall.picker.hintLimit', { count: limit })}`}
        </p>
        {candidates.length > 0 ? (
          <>
            <div className="flex items-center justify-between text-[13px]">
              <span data-testid="group-call-picked" className="text-fg-2">
                {t('groupCall.picker.picked', { count: chosen.length })}
              </span>
              <button
                type="button"
                className="rounded-control px-2 py-1 text-accent-fg hover:bg-hover max-md:min-h-11"
                onClick={() =>
                  setPicked(all ? new Set() : new Set(candidates.map((member) => member.user.id)))
                }
              >
                {all ? t('groupCall.picker.none') : t('groupCall.picker.all')}
              </button>
            </div>
            <ul className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
              {candidates.map((member) => {
                const selected = picked.has(member.user.id)
                return (
                  <li key={member.user.id}>
                    <label
                      data-testid="group-call-pick"
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-2 py-1.5 hover:bg-hover"
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggle(member.user.id)}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden
                        className={`grid size-5 flex-none place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                          selected ? 'border-accent bg-accent text-on-accent' : 'border-border'
                        }`}
                      >
                        {selected && <Check size={14} strokeWidth={2} />}
                      </span>
                      <Avatar user={member.user} size={32} />
                      <span className="min-w-0 flex-1 truncate">{memberName(member)}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <p className="py-6 text-center text-fg-3">
            {members === undefined ? tCommon('loading') : t('groupCall.picker.nobody')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="group-call-confirm"
            // 发起时可以一个人都不邀请：别人看到"通话进行中"会自己进来。再邀请时至少选一个
            disabled={mode === 'invite' && chosen.length === 0}
            onClick={() => onConfirm(chosen.map((member) => member.user.id))}
          >
            {mode === 'start' ? t('groupCall.picker.start') : t('groupCall.picker.invite')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
