import { describe, expect, it } from 'vitest'
import { sanitizeToolResultContentForModel } from '../toolResultSanitizer.js'

describe('sanitizeToolResultContentForModel', () => {
  it('collapses html payloads to a short model-facing confirmation', () => {
    const result = sanitizeToolResultContentForModel(
      { type: 'text/html', content: '<html><body><h1>Rendered</h1></body></html>' },
      'html_renderer'
    )

    expect(result).toBe('displaying html_renderer ui now')
  })

  it('uses plan_md modelContent instead of full displayed plan content', () => {
    const result = sanitizeToolResultContentForModel(
      {
        displayed: true,
        exists: true,
        name: 'sample-plan',
        content: '# Long plan\n\nThis full markdown should stay out of model context.',
        modelContent: 'Plan "sample-plan" was displayed to the user in the chat view. Do not repeat the plan unless the user asks.',
      },
      'plan_md'
    )

    expect(result).toBe('Plan "sample-plan" was displayed to the user in the chat view. Do not repeat the plan unless the user asks.')
  })

  it('uses plan_md modelContent from stringified tool results', () => {
    const result = sanitizeToolResultContentForModel(
      JSON.stringify({
        content: '# Long plan',
        modelContent: 'Plan "stringified-plan" was displayed to the user in the chat view.',
      }),
      'plan_md'
    )

    expect(result).toBe('Plan "stringified-plan" was displayed to the user in the chat view.')
  })

  it('uses plan_md create modelContent without requiring echoed plan content', () => {
    const result = sanitizeToolResultContentForModel(
      {
        name: 'created-plan',
        created: true,
        path: '/tmp/.ygg/plans/created-plan.md',
        message: 'Created plan "created-plan".',
        modelContent: 'Created plan "created-plan". Do not repeat the plan unless the user asks.',
      },
      'plan_md'
    )

    expect(result).toBe('Created plan "created-plan". Do not repeat the plan unless the user asks.')
  })
})



describe('view_image model-facing content', () => {
  it('passes through split-channel typed image content without wrapping it as text', () => {
    const modelContent = [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'high' }]

    expect(sanitizeToolResultContentForModel(modelContent, 'view_image')).toEqual(modelContent)
  })

  it('continues to read legacy duplicated view_image results', () => {
    const result = sanitizeToolResultContentForModel(
      {
        image_url: 'data:image/png;base64,aGVsbG8=',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'original' }],
      },
      'view_image'
    )

    expect(result).toEqual([{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'original' }])
  })
})
