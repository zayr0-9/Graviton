import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { isManagedToolPath } from '../managedToolPaths.js'

describe('isManagedToolPath', () => {
  const originalEnv = {
    YGG_APP_USER_DATA: process.env.YGG_APP_USER_DATA,
    YGG_HOOKS_DIRECTORY: process.env.YGG_HOOKS_DIRECTORY,
    YGG_THEME_DIRECTORY: process.env.YGG_THEME_DIRECTORY,
    YGG_CUSTOM_TOOLS_DIRECTORY: process.env.YGG_CUSTOM_TOOLS_DIRECTORY,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('allows paths under managed .ygg and custom-tools roots', () => {
    const userData = path.join(os.tmpdir(), 'ygg-managed-user-data')
    process.env.YGG_APP_USER_DATA = userData

    expect(isManagedToolPath(path.join(userData, '.ygg', 'custom-themes', 'cotton-candy-dream.json'), false)).toBe(true)
    expect(isManagedToolPath(path.join(userData, 'custom-tools', 'my-tool', 'definition.json'), false)).toBe(true)
    expect(isManagedToolPath(path.join(userData, 'generated_images', 'abc123.png'), false)).toBe(true)
    expect(isManagedToolPath(path.join(userData, 'outside.txt'), false)).toBe(false)
  })

  it('respects explicit environment overrides', () => {
    const themeDir = path.join(os.tmpdir(), 'ygg-theme-override')
    const toolsBaseDir = path.join(os.tmpdir(), 'ygg-tools-base')
    process.env.YGG_THEME_DIRECTORY = themeDir
    process.env.YGG_CUSTOM_TOOLS_DIRECTORY = toolsBaseDir

    expect(isManagedToolPath(path.join(themeDir, 'sunset.json'), false)).toBe(true)
    expect(isManagedToolPath(path.join(toolsBaseDir, 'custom-tools', 'demo', 'index.js'), false)).toBe(true)
    expect(isManagedToolPath(path.join(toolsBaseDir, 'other', 'index.js'), false)).toBe(false)
  })
})
