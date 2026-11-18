import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { groupsQuery } from '../../chat'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { useErrorMessage } from '../../errors'
import { ConversationAvatar } from '../chats/ConversationAvatar'
import { displayName } from '../chats/text'
import { PaneHeader } from './PaneHeader'

/** 群聊：我所在的全部群，点一个进入它的会话。 */
export function GroupsPane() {
  const { t } = useTranslation('contacts')
  const { t: tChats } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const groups = useQuery(groupsQuery)

  return (
    <div className="flex h-full flex-col">
      <PaneHeader title={t('groups.title')} />
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.isError ? (
          <LoadError message={errorMessage(groups.error)} onRetry={() => void groups.refetch()} />
        ) : !groups.data ? (
          <ListSkeleton rows={3} />
        ) : groups.data.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-fg-3">
            <p>{t('groups.empty')}</p>
            <p className="text-[12px]">{t('groups.emptyHint')}</p>
          </div>
        ) : (
          <ul data-testid="group-list" className="mx-auto max-w-[560px] py-2">
            {groups.data.map((group) => (
              <li key={group.id}>
                <Link
                  to="/chats/$conversationId"
                  params={{ conversationId: group.id }}
                  data-testid="group"
                  className="flex h-14 items-center gap-3 px-4 transition-colors duration-150 hover:bg-hover"
                >
                  <ConversationAvatar conversation={group} size={36} />
                  <span data-testid="group-label" className="min-w-0 flex-1 truncate">
                    {displayName(group, tChats)}
                  </span>
                  <span className="flex-none text-[12px] text-fg-3">
                    {t('groups.memberCount', { count: group.group?.member_count ?? 0 })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
