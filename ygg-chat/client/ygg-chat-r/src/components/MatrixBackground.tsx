import { useEffect, useRef, useState } from 'react'
import { loadMatrixSettings, publishMatrixRuntimeStatus } from '../helpers/matrixBackgroundStorage'
import { VIDEO_BACKGROUND_CHANGE_EVENT } from '../helpers/videoBackgroundStorage'

export default function MatrixBackground() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [settings, setSettings] = useState(loadMatrixSettings)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retries = useRef(0)
  const params = new URLSearchParams({
    preset: settings.preset, fps: String(settings.fps), speed: String(settings.speed), columns: String(settings.columns),
  })
  // Trusted local content, not an untrusted-HTML sandbox boundary. Electron's
  // default GrantFileProtocolExtraPrivileges fuse permits local modules/shader fetches.
  // Vite's relative base keeps packaged loadFile() and development assets working.
  const source = `${import.meta.env.BASE_URL}wallpapers/matrix/wallpaper.html?${params}`

  useEffect(() => {
    const refresh = () => setSettings(loadMatrixSettings())
    window.addEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, refresh)
    return () => window.removeEventListener(VIDEO_BACKGROUND_CHANGE_EVENT, refresh)
  }, [])

  useEffect(() => { retries.current = 0 }, [source])

  useEffect(() => {
    setFailed(false)
    publishMatrixRuntimeStatus('loading')
    let retryTimer: number | undefined
    let stableTimer: number | undefined
    let rejected = false
    const fail = () => {
      if (rejected) return
      rejected = true
      window.clearTimeout(timeout)
      window.clearTimeout(stableTimer)
      setFailed(true)
      if (retries.current < 2) {
        retries.current++
        publishMatrixRuntimeStatus('retrying')
        retryTimer = window.setTimeout(() => setAttempt(value => value + 1), 1500)
      } else publishMatrixRuntimeStatus('error')
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => frame.current?.contentWindow?.postMessage({
      type: 'graviton:matrix-pause', paused: document.hidden || motion.matches,
    }, '*')
    const timeout = window.setTimeout(fail, 20000)
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'graviton:matrix-status') return
      if (rejected) return
      if (event.data.status === 'ready') {
        window.clearTimeout(timeout)
        publishMatrixRuntimeStatus('ready')
        window.clearTimeout(stableTimer)
        stableTimer = window.setTimeout(() => { retries.current = 0 }, 60000)
        sync()
      } else if (event.data.status === 'error') fail()
    }
    window.addEventListener('message', onMessage)
    document.addEventListener('visibilitychange', sync)
    motion.addEventListener('change', sync)
    return () => {
      window.clearTimeout(timeout)
      window.clearTimeout(retryTimer)
      window.clearTimeout(stableTimer)
      publishMatrixRuntimeStatus('idle')
      window.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', sync)
      motion.removeEventListener('change', sync)
    }
  }, [source, attempt])

  return (
    <div aria-hidden='true' className='fixed inset-0 w-full h-full pointer-events-none -z-10' style={{ backgroundColor: '#050805' }}>
      {!failed && <iframe
        key={`${source}:${attempt}`}
        ref={frame}
        title='Live Matrix wallpaper'
        src={source}
        tabIndex={-1}
        sandbox='allow-scripts allow-same-origin'
        allow="camera 'none'; microphone 'none'; geolocation 'none'"
        className='h-full w-full border-0'
      />}
      <div className='absolute inset-0 bg-black/35' />
    </div>
  )
}
