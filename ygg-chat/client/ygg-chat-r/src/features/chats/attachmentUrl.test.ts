import { describe, expect, it } from 'vitest'
import { resolveAttachmentUrlFromOrigins } from './attachmentUrl'

const origins = {
  localOrigin: 'http://127.0.0.1:4567',
  localApiBase: 'http://127.0.0.1:4567/api',
  remoteOrigin: 'https://cloud.example.com',
}

describe('resolveAttachmentUrlFromOrigins', () => {
  it('serves absolute POSIX paths through the attachment-id route on the Ygg origin', () => {
    expect(
      resolveAttachmentUrlFromOrigins({
        ...origins,
        filePath: '/Users/me/data/user_images/hash.png',
        attachmentId: 'att 1',
      })
    ).toBe('http://127.0.0.1:4567/api/local/attachments/att%201/file')
  })

  it('serves absolute Windows paths through the attachment-id route', () => {
    expect(
      resolveAttachmentUrlFromOrigins({
        ...origins,
        filePath: 'C:\\Users\\me\\user_images\\hash.png',
        attachmentId: 'att-2',
      })
    ).toBe('http://127.0.0.1:4567/api/local/attachments/att-2/file')
  })

  it('serves absolute /data paths through the attachment-id route', () => {
    expect(
      resolveAttachmentUrlFromOrigins({
        ...origins,
        filePath: '/data/user_images/hash.png',
        attachmentId: 'att-data',
      })
    ).toBe('http://127.0.0.1:4567/api/local/attachments/att-data/file')
  })

  it('resolves local API paths against the Ygg origin instead of the cloud origin', () => {
    expect(
      resolveAttachmentUrlFromOrigins({
        ...origins,
        urlOrPath: '/local/attachments/att-3/file',
      })
    ).toBe('http://127.0.0.1:4567/api/local/attachments/att-3/file')
  })

  it('keeps cloud upload paths on the remote origin', () => {
    expect(
      resolveAttachmentUrlFromOrigins({
        ...origins,
        filePath: 'data/uploads/photo.png',
      })
    ).toBe('https://cloud.example.com/uploads/photo.png')
  })

  it('does not expose absolute filesystem paths without an attachment id', () => {
    expect(
      resolveAttachmentUrlFromOrigins({
        ...origins,
        filePath: '/Users/me/data/user_images/hash.png',
      })
    ).toBeNull()
  })
})
