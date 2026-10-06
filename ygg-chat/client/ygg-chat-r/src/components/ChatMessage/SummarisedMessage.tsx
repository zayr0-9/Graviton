import { Archive } from 'lucide-react'
import { CompactMessageNotice, type CompactMessageNoticeProps } from './CompactMessageNotice'

/** Display-only compaction marker. Deliberately accepts no summary content or blocks. */
export function SummarisedMessage(props: CompactMessageNoticeProps) {
  return (
    <CompactMessageNotice {...props} kind='summary'
      title='Earlier context is preserved in a summary and still used by the model.'
      icon={<Archive size={14} className='shrink-0' aria-hidden='true' />}>
      Conversation summarised
    </CompactMessageNotice>
  )
}
