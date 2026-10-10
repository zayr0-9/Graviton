interface QuitConfirmationOptions {
  platform: NodeJS.Platform
  isReady: () => boolean
  confirm: () => boolean
}

// Keep the guard independent of Electron so cancellation and reentrant quit
// requests can be tested without starting the desktop app.
export function createQuitConfirmationGuard(options: QuitConfirmationOptions): () => boolean {
  let confirmationOpen = false

  return () => {
    if (options.platform !== 'darwin' || !options.isReady()) return true
    if (confirmationOpen) return false

    confirmationOpen = true
    try {
      return options.confirm()
    } finally {
      confirmationOpen = false
    }
  }
}
