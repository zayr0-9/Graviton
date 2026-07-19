import { describe, expect, it } from 'vitest'
import {
  appendAttachedImagePathMetadata,
  extractAttachedImagePaths,
  stripAttachedImagePathMetadata,
} from './attachedImagePaths'

describe('attached image path metadata', () => {
  it('appends a versioned machine-readable block and hides it from visible content', () => {
    const content = appendAttachedImagePathMetadata('Please inspect these images.', [
      '/app/user_images/a.png',
      '/app/user_images/b.jpg',
    ])

    expect(content).toContain('<ygg-attached-image-paths-v1>')
    expect(extractAttachedImagePaths(content)).toEqual(['/app/user_images/a.png', '/app/user_images/b.jpg'])
    expect(stripAttachedImagePathMetadata(content)).toBe('Please inspect these images.')
  })

  it('deduplicates paths and replaces an existing metadata block', () => {
    const initial = appendAttachedImagePathMetadata('Message', ['/app/user_images/a.png'])
    const updated = appendAttachedImagePathMetadata(initial, ['/app/user_images/a.png', '/app/user_images/b.png'])

    expect(extractAttachedImagePaths(updated)).toEqual(['/app/user_images/a.png', '/app/user_images/b.png'])
    expect(updated.match(/<ygg-attached-image-paths-v1>/g)).toHaveLength(1)
  })

  it('leaves ordinary user content unchanged', () => {
    expect(stripAttachedImagePathMetadata('ordinary message')).toBe('ordinary message')
    expect(extractAttachedImagePaths('ordinary message')).toEqual([])
  })
})
