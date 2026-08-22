import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { execute } from '../themeManager.js'

describe.sequential('theme_manager tool', () => {
  let tempRoot = ''
  let managedDir = ''
  let bundledDir = ''
  const originalManagedDir = process.env.YGG_THEME_DIRECTORY
  const originalTemplateDir = process.env.YGG_THEME_TEMPLATE_DIRECTORY

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-theme-manager-'))
    managedDir = path.join(tempRoot, 'managed')
    bundledDir = path.join(tempRoot, 'bundled')
    process.env.YGG_THEME_DIRECTORY = managedDir
    process.env.YGG_THEME_TEMPLATE_DIRECTORY = bundledDir
    await fs.mkdir(bundledDir, { recursive: true })
  })

  afterEach(async () => {
    if (originalManagedDir === undefined) {
      delete process.env.YGG_THEME_DIRECTORY
    } else {
      process.env.YGG_THEME_DIRECTORY = originalManagedDir
    }

    if (originalTemplateDir === undefined) {
      delete process.env.YGG_THEME_TEMPLATE_DIRECTORY
    } else {
      process.env.YGG_THEME_TEMPLATE_DIRECTORY = originalTemplateDir
    }

    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('copies bundled themes into the managed directory when listing', async () => {
    await fs.writeFile(
      path.join(bundledDir, 'starter.json'),
      JSON.stringify({ name: 'Starter Theme' }, null, 2),
      'utf8'
    )

    const result = await execute({ action: 'list' })

    expect(result.success).toBe(true)
    expect(result.directory).toBe(managedDir)
    expect(result.totalCount).toBe(1)
    expect(result.themes?.[0]?.id).toBe('starter')
    expect(await fs.readFile(path.join(managedDir, 'starter.json'), 'utf8')).toContain('Starter Theme')
  })

  it('saves, lists, reads, and deletes managed theme files', async () => {
    const saveResult = await execute({
      action: 'save',
      theme: {
        name: 'Solar Fog',
        colors: {
          chatPanelBg: {
            light: '#f8f5ef',
            dark: '#18181b',
          },
        },
      },
    })

    expect(saveResult.success).toBe(true)
    expect(saveResult.id).toBe('solar-fog')
    expect(saveResult.created).toBe(true)
    expect(saveResult.theme?.name).toBe('Solar Fog')
    expect(saveResult.theme?.colors.chatMessageListBg.dark).toBe('oklch(20.5% 0 0)')

    const listResult = await execute({ action: 'list' })
    expect(listResult.success).toBe(true)
    expect(listResult.totalCount).toBe(1)
    expect(listResult.themes?.[0]?.name).toBe('Solar Fog')

    const readResult = await execute({ action: 'read', name: 'solar-fog' })
    expect(readResult.success).toBe(true)
    expect(readResult.exists).toBe(true)
    expect(readResult.theme?.colors.chatPanelBg.light).toBe('#f8f5ef')
    expect(readResult.theme?.colors.heimdallNodes.ex_agent.visibleStroke.dark).toBe('#ea580c')
    // Ensure newly added theme surfaces are persisted/sanitized by the tool schema.
    expect(readResult.theme?.colors.ideContextPreviewBg.dark).toBe('rgba(10, 10, 10, 0.95)')
    expect(readResult.theme?.colors.toolJobsModalBorder.dark).toBe('#262626')
    expect(readResult.theme?.colors.authModalSurfaceBg.dark).toBe('#09090b')
    expect(readResult.theme?.colors.htmlToolsModalButtonActiveText.light).toBe('#171717')

    const deleteResult = await execute({ action: 'delete', name: 'solar-fog' })
    expect(deleteResult.success).toBe(true)
    expect(deleteResult.deleted).toBe(true)

    const afterDeleteRead = await execute({ action: 'read', name: 'solar-fog' })
    expect(afterDeleteRead.success).toBe(true)
    expect(afterDeleteRead.exists).toBe(false)
  })
})
