import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../Button/button'

interface UpdateInfo {
  version: string
  releaseNotes?: string | Array<{ note?: string }>
  /** macOS: builds are unsigned, so the update is downloaded manually from GitHub. */
  manualInstall?: boolean
  releaseUrl?: string
}

interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export const UpdateModal: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [isManual, setIsManual] = useState(false)

  const handleOpenReleasePage = useCallback(async () => {
    try {
      await window.electronAPI?.autoUpdater?.openReleasePage?.()
    } catch (error) {
      console.error('Failed to open release page:', error)
    }
    setIsOpen(false)
  }, [])

  const handleInstallNow = useCallback(async () => {
    if (!window.electronAPI?.autoUpdater) return
    setIsInstalling(true)
    try {
      await window.electronAPI.autoUpdater.installNow()
    } catch (error) {
      console.error('Failed to install update:', error)
      setIsInstalling(false)
    }
  }, [])

  const handleLater = useCallback(() => {
    setIsOpen(false)
    // Update will install when app is closed
  }, [])

  useEffect(() => {
    // Only run in Electron
    if (!window.electronAPI?.autoUpdater) return

    const cleanups: (() => void)[] = []

    // Update available - show downloading state
    cleanups.push(
      window.electronAPI.autoUpdater.onUpdateAvailable(info => {
        setUpdateInfo(info)
        const manual = info?.manualInstall === true
        setIsManual(manual)
        setIsDownloading(!manual)
        setIsOpen(true)
      })
    )

    // Download progress
    cleanups.push(
      window.electronAPI.autoUpdater.onDownloadProgress(progress => {
        setDownloadProgress(progress)
      })
    )

    // Update downloaded - ready to install
    cleanups.push(
      window.electronAPI.autoUpdater.onUpdateDownloaded(info => {
        setUpdateInfo(info)
        setIsDownloading(false)
        setIsReady(true)
        setIsOpen(true)
      })
    )

    // Error handling
    cleanups.push(
      window.electronAPI.autoUpdater.onError(error => {
        console.error('[UpdateModal] Update error:', error)
        setIsDownloading(false)
        setIsOpen(false)
      })
    )

    return () => {
      cleanups.forEach(cleanup => cleanup())
    }
  }, [])

  if (!isOpen) return null

  const normalizedReleaseNotes = (() => {
    const raw = updateInfo?.releaseNotes
    if (!raw) return []

    if (typeof raw === 'string') {
      return raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    }

    if (Array.isArray(raw)) {
      return raw
        .map(item => item?.note?.trim())
        .filter((note): note is string => Boolean(note))
    }

    return []
  })()

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200'>
      <div className='bg-white dark:bg-yBlack-900 rounded-2xl shadow-2xl border border-neutral-200 dark:border-neutral-700 p-6 max-w-md w-full mx-4 animate-in slide-in-from-bottom-4 duration-300'>
        <div className='flex flex-col items-center text-center'>
          {/* Icon */}
          <div className='flex-shrink-0 p-4 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 mb-4'>
            <i className={`bx ${isDownloading ? 'bx-download bx-tada' : 'bx-rocket'} text-4xl`}></i>
          </div>

          {/* Title */}
          <h2 className='text-2xl font-semibold text-neutral-900 dark:text-neutral-100 mb-2'>
            {isManual ? 'Update Available' : isDownloading ? 'Downloading Update...' : 'Update Ready!'}
          </h2>

          {/* Version info */}
          {updateInfo && (
            <p className='text-neutral-600 dark:text-neutral-400 mb-4'>
              Version <span className='font-semibold text-green-600 dark:text-green-400'>{updateInfo.version}</span>{' '}
              {isManual ? 'is available' : isDownloading ? 'is downloading' : 'is ready to install'}
            </p>
          )}

          {normalizedReleaseNotes.length > 0 && (
            <div className='w-full mb-4 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 text-left'>
              <p className='text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-2'>What&apos;s new</p>
              <ul className='space-y-1 text-sm text-neutral-700 dark:text-neutral-200'>
                {normalizedReleaseNotes.slice(0, 8).map((note, index) => (
                  <li key={`${index}-${note.slice(0, 24)}`} className='flex gap-2'>
                    <span className='text-green-500 mt-[2px]'>•</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Download progress bar */}
          {isDownloading && downloadProgress && (
            <div className='w-full mb-6'>
              <div className='w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2 mb-2'>
                <div
                  className='bg-green-500 h-2 rounded-full transition-all duration-300'
                  style={{ width: `${downloadProgress.percent}%` }}
                />
              </div>
              <div className='flex justify-between text-xs text-neutral-500 dark:text-neutral-400'>
                <span>
                  {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
                </span>
                <span>{downloadProgress.percent.toFixed(0)}%</span>
              </div>
            </div>
          )}

          {isManual && (
            <>
              <p className='text-sm text-neutral-500 dark:text-neutral-400 mb-6'>
                Download the new version from GitHub Releases and replace the app to update.
              </p>
              <div className='flex flex-col sm:flex-row items-center gap-2 w-full'>
                <Button
                  variant='outline2'
                  size='medium'
                  onClick={handleLater}
                  className='w-full sm:w-auto text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 border-neutral-200 dark:border-neutral-700'
                >
                  Later
                </Button>
                <Button
                  variant='outline2'
                  size='medium'
                  onClick={handleOpenReleasePage}
                  className='w-full sm:w-auto border-0 bg-green-600 hover:bg-green-700 text-white'
                >
                  <i className='bx bx-link-external mr-2'></i>
                  Download from GitHub
                </Button>
              </div>
            </>
          )}

          {/* Description for ready state */}
          {isReady && (
            <p className='text-sm text-neutral-500 dark:text-neutral-400 mb-6'>
              The update has been downloaded. You can install it now and restart, or it will be installed automatically
              when you close the app.
            </p>
          )}

          {/* Actions */}
          {isReady && (
            <div className='flex flex-col sm:flex-row items-center gap-2 w-full'>
              <Button
                variant='outline2'
                size='medium'
                onClick={handleLater}
                disabled={isInstalling}
                className='w-full sm:w-auto text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 border-neutral-200 dark:border-neutral-700'
              >
                Install on Close
              </Button>
              <Button
                variant='outline2'
                size='medium'
                onClick={handleInstallNow}
                disabled={isInstalling}
                className='w-full sm:w-auto border-0 bg-green-600 hover:bg-green-700 text-white'
              >
                {isInstalling ? (
                  <>
                    <i className='bx bx-loader-alt bx-spin mr-2'></i>
                    Installing...
                  </>
                ) : (
                  <>
                    <i className='bx bx-rocket mr-2'></i>
                    Install Now & Restart
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
