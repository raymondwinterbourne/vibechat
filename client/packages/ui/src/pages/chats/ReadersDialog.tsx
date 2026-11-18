import { memberName, type Readers } from '@vibechat/core'
import type { MemberView } from '@vibechat/protocol'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'

function People({
  testId,
  title,
  people,
}: {
  testId: string
  title: string
  people: MemberView[]
}) {
  const { t } = useTranslation('chats')
  return (
    <section data-testid={testId} className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="text-[12px] text-fg-2">{title}</h3>
      {people.length === 0 ? (
        <p className="text-fg-3">{t('readers.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {people.map((member) => (
            <li key={member.user.id} className="flex items-center gap-2">
              <Avatar user={member.user} size={28} />
              <span className="min-w-0 flex-1 truncate">{memberName(member)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 我发的一条群消息：谁读了，谁还没读。 */
export function ReadersLists({ readers }: { readers: Readers }) {
  const { t } = useTranslation('chats')
  return (
    <div className="flex max-h-[50dvh] gap-4 overflow-auto">
      <People
        testId="readers-read"
        title={t('readers.read', { count: readers.read.length })}
        people={readers.read}
      />
      <People
        testId="readers-unread"
        title={t('readers.unread', { count: readers.unread.length })}
        people={readers.unread}
      />
    </div>
  )
}
