import { toast } from 'vue-sonner'
import type { ComposerTranslation } from 'vue-i18n'
import type { MentionAccessNote } from '@knowledge/contracts'
import { formatList } from '@/shared/utils/format'

/**
 * After a comment is posted (#76, phase 5): the people it named who cannot
 * open the page were not notified, and the author should know why. The API
 * returns their ids; names come from the roster the page already holds.
 *
 * A toast rather than an inline banner: it is about the act just taken, not a
 * standing state of the page, and its action opens the Access dialog, where a
 * manager grants view and anyone else sees who manages the page.
 */
export function warnMentionedWithoutAccess(
  result: unknown,
  opts: { t: ComposerTranslation; nameOf: (id: string) => string; openAccess: () => void },
): void {
  const ids = (result as Partial<MentionAccessNote> | null | undefined)?.mentionedWithoutAccess
  if (!Array.isArray(ids) || ids.length === 0) return
  const names = formatList(ids.map(opts.nameOf))
  toast.warning(opts.t('access.mention.title', { names }, ids.length), {
    description: opts.t('access.mention.hint'),
    duration: 12_000,
    action: { label: opts.t('access.mention.grant'), onClick: opts.openAccess },
  })
}
