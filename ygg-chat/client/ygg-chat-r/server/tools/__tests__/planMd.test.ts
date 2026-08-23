import { describe, expect, it } from 'vitest'
import { createPlan, executePlanMd } from '../planMd.js'
import { createToolFsHarness } from './helpers/toolFsHarness.js'

describe('plan_md create', () => {
  it('writes the plan file but does not return markdown content in the create result', async () => {
    const harness = await createToolFsHarness('ygg-plan-md-test-')
    const content = '# Long plan\n\nThis should be saved to disk but not echoed in the tool result.'

    const result = await createPlan(content, 'sample-plan', harness.workspaceDir)

    expect(result).toMatchObject({
      name: 'sample-plan',
      created: true,
      message: 'Created plan "sample-plan".',
      modelContent: 'Created plan "sample-plan". Do not repeat the plan unless the user asks.',
    })
    expect(result.path).toBe(harness.absolutePath('.ygg/plans/sample-plan.md'))
    expect(result).not.toHaveProperty('content')
    expect(await harness.readFile('.ygg/plans/sample-plan.md')).toBe(content)
  })

  it('returns metadata-only create output through executePlanMd', async () => {
    const harness = await createToolFsHarness('ygg-plan-md-execute-test-')
    const content = '# Execute plan\n\nCreated through executePlanMd.'

    const result = await executePlanMd(
      {
        action: 'create',
        name: 'execute-plan',
        content,
      },
      harness.workspaceDir
    )

    expect(result.name).toBe('execute-plan')
    expect(result.created).toBe(true)
    expect(result.message).toBe('Created plan "execute-plan".')
    expect(result.modelContent).toBe('Created plan "execute-plan". Do not repeat the plan unless the user asks.')
    expect(result).not.toHaveProperty('content')
    expect(await harness.readFile('.ygg/plans/execute-plan.md')).toBe(content)
  })
})


describe('plan_md display', () => {
  it('displays a Markdown file specified by an absolute path outside .ygg/plans', async () => {
    const harness = await createToolFsHarness('ygg-plan-md-display-path-test-')
    const filePath = await harness.writeFile('docs/external-plan.md', '# External plan\n\nDisplayed from its file path.')

    const result = await executePlanMd(
      {
        action: 'display',
        path: filePath,
      },
      harness.workspaceDir
    )

    expect(result).toMatchObject({
      displayed: true,
      exists: true,
      name: 'external-plan',
      path: filePath,
      content: '# External plan\n\nDisplayed from its file path.',
    })
  })

  it('resolves relative display paths from cwd', async () => {
    const harness = await createToolFsHarness('ygg-plan-md-display-relative-test-')
    const filePath = await harness.writeFile('docs/relative-plan.md', '# Relative plan')

    const result = await executePlanMd(
      {
        action: 'display',
        path: 'docs/relative-plan.md',
      },
      harness.workspaceDir
    )

    expect(result).toMatchObject({ displayed: true, path: filePath, content: '# Relative plan' })
  })
})
