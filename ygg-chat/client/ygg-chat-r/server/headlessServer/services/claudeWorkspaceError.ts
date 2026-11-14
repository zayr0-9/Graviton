import { attachChatErrorCode } from '../providers/providerErrorFormatter.js'

/** Both checkpoint continuation and branch reservation enforce the same workspace lock. */
export function claudeWorkspaceChangedError(originalCwd: string, selectedCwd: string): Error {
  return attachChatErrorCode(new Error(
    `Claude branch workspace is locked.\nOriginal folder: ${originalCwd}\nSelected folder: ${selectedCwd}`,
  ), 'claude_workspace_changed')
}
