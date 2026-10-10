/** Only persisted attachment metadata can acknowledge an accepted user image. */
export function hasAcceptedImageAttachments(message: { role?: string; attachments?: unknown } | null | undefined): boolean {
  return message?.role === 'user' && Array.isArray(message.attachments) && message.attachments.some(
    attachment => attachment && typeof attachment.id === 'string' &&
      typeof attachment.mime_type === 'string' && attachment.mime_type.startsWith('image/')
  )
}
