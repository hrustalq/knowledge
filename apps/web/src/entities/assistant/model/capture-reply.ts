import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { errorMessage } from '@/shared/api/errors'
import { useAssistantStore } from './assistant.store'

/**
 * Saves a reply to the knowledge base and says where it went: the reply's
 * bookmark button and the composer's `/capture` (#1249) are one act.
 */
export function useCaptureReply() {
  const { t } = useI18n()
  const router = useRouter()
  const assistant = useAssistantStore()

  return async function captureReply(messageId: string): Promise<void> {
    try {
      const result = await assistant.captureReply(messageId)
      if (result.state === 'duplicate' && result.targetDocumentId) {
        const page = result.targetDocumentId
        toast.info(t('assistant.saveToKb.duplicate'), {
          action: { label: t('assistant.saveToKb.openPage'), onClick: () => void router.push(`/documents/${page}`) },
        })
      } else if (result.mergeRequestId) {
        const mr = result.mergeRequestId
        toast.success(result.outcome === 'amend-page' ? t('assistant.saveToKb.amended') : t('assistant.saveToKb.proposed'), {
          action: { label: t('assistant.saveToKb.openMergeRequest'), onClick: () => void router.push(`/merge-requests/${mr}`) },
        })
      } else {
        toast.success(t('assistant.saveToKb.staged'))
      }
    } catch (e) {
      toast.error(errorMessage(e, t))
    }
  }
}
