import { useQuery } from '@tanstack/react-query'
import { filterFriends, friendName, sortFriends } from '@vibechat/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { friendsQuery } from '../../contacts'
import { usePreferences } from '../../preferences'

interface FriendPickerProps {
  /** 选中的好友的内部编号。 */
  selected: string[]
  onChange: (selected: string[]) => void
  /** 不用选的人：已经在群里的，或者正在和我聊天的那一位。显示为已勾选、不能改。 */
  taken?: ReadonlySet<string>
  /** 这些人旁边的说明。不给就是"已在群里"。 */
  takenLabel?: string
  disabled?: boolean
}

/** 从好友里勾选几个人。建群和邀请入群时用。 */
export function FriendPicker({
  selected,
  onChange,
  taken,
  takenLabel,
  disabled,
}: FriendPickerProps) {
  const { t } = useTranslation('chats')
  const language = usePreferences((state) => state.language)
  const friends = useQuery(friendsQuery)
  const [filter, setFilter] = useState('')

  const all = friends.data ?? []
  const shown = sortFriends(filterFriends(all, filter), language)

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label={t('picker.filter')}
        placeholder={t('picker.filter')}
        className="h-11 w-full rounded-control border border-border bg-bg px-3 text-fg placeholder:text-fg-3 md:h-9"
      />
      {friends.data && shown.length === 0 ? (
        <div className="py-6 text-center text-fg-3">
          <p>{all.length === 0 ? t('picker.empty') : t('picker.noMatch')}</p>
          {all.length === 0 && <p className="text-[12px]">{t('picker.emptyHint')}</p>}
        </div>
      ) : (
        <ul className="-mx-2 max-h-[40dvh] overflow-auto">
          {shown.map((friend) => {
            const inGroup = taken?.has(friend.user.id) ?? false
            return (
              <li key={friend.user.id}>
                <label
                  data-testid="pick-friend"
                  className={`flex h-12 items-center gap-3 rounded-control px-2 ${
                    inGroup || disabled ? 'opacity-50' : 'cursor-pointer hover:bg-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={inGroup || selected.includes(friend.user.id)}
                    disabled={inGroup || disabled}
                    onChange={() => toggle(friend.user.id)}
                    className="size-4 flex-none accent-accent"
                  />
                  <Avatar user={friend.user} size={32} />
                  <span className="min-w-0 flex-1 truncate">{friendName(friend)}</span>
                  {inGroup && (
                    <span className="flex-none text-[12px] text-fg-3">
                      {takenLabel ?? t('picker.inGroup')}
                    </span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
