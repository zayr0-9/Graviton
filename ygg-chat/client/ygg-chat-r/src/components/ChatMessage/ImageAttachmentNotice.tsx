import { Image } from 'lucide-react'
import { GENERATED_IMAGE_PATH_HINT_NOTE } from '../../features/chats/chatActions'
import { CompactMessageNotice, type CompactMessageNoticeProps } from './CompactMessageNotice'

/** Match the persisted model-reference marker, not user-authored prose. */
export function isImageAttachmentInfoMessage(message: { note?: string | null } | undefined): boolean {
  return message?.note === GENERATED_IMAGE_PATH_HINT_NOTE
}

export function ImageAttachmentNotice(props: CompactMessageNoticeProps) {
  return (
    <CompactMessageNotice {...props} kind='image' title='Image attached'
      icon={<Image size={14} className='shrink-0' aria-hidden='true' />}>
      Image attached
    </CompactMessageNotice>
  )
}
