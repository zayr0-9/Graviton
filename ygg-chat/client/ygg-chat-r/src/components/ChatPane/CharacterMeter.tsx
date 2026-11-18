import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { characterMeterPalette, createMeterCanvas } from './CharacterMeterCanvas'
import { meterScopes, sequencesSince, spectrumKeys, summarizeMeter, type MeterReading, type MeterScope, type MeterStyle } from '../../features/chats/characterMeter'
import { useAppSelector } from '../../hooks/redux'
import type { CustomChatTheme } from '../ThemeManager/themeConfig'
import './characterMeter.css'

export const CharacterMeter = memo(function CharacterMeter({ streamId, style, scope, theme, dark }: {
  streamId: string | null; style: MeterStyle; scope: MeterScope; theme?: CustomChatTheme; dark: boolean
}) {
  // The branch-aware selector releases the stream on completion. Read its last update even if
  // React batches that update with completion. The parent remounts this component on navigation.
  const lastStream = useRef(streamId)
  useLayoutEffect(() => { if (streamId) lastStream.current = streamId }, [streamId])
  const id = streamId ?? lastStream.current
  const reading = useAppSelector(state => id ? state.chat.streaming.byId[id]?.characterMeter : undefined)
  const retained = useRef<{ id: string; reading?: MeterReading }>(null)
  useEffect(() => { if (reading) retained.current = { id, reading } }, [id, reading])
  const data = reading ?? (!streamId && retained.current?.id === id ? retained.current?.reading : undefined)
  const value = useMemo(() => summarizeMeter(data, scope), [data, scope])
  const palette = useMemo(() => characterMeterPalette(theme, dark), [theme, dark])
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ReturnType<typeof createMeterCanvas>>(null)
  const cursor = data?.recent?.at(-1)?.id ?? 0
  const previous = useRef({ id, scope, cursor })
  useEffect(() => {
    const engine = createMeterCanvas(canvas.current!, style, palette)
    renderer.current = engine
    return () => { engine?.destroy(); renderer.current = null }
  }, [style, scope, palette, id])
  useEffect(() => {
    const prev = previous.current
    if (scope === prev.scope) {
      const after = id === prev.id && cursor >= prev.cursor ? prev.cursor : 0
      for (const seq of sequencesSince(data, scope, after)) renderer.current?.enqueue(seq)
    }
    previous.current = { id, scope, cursor }
  }, [id, scope, data, cursor])
  return <div className='output-meter' data-spectrum={style === 'spectrum'} style={{ color: palette.text }}
    tabIndex={style === 'spectrum' ? 0 : undefined} aria-label={`${meterScopes[scope]}: ${value.total.toLocaleString()} characters`} role='group'>
    <div className='output-meter-track'>
      <canvas ref={canvas} aria-hidden='true' />
      {style === 'spectrum' && <div className='output-meter-key' aria-hidden='true'>
        {spectrumKeys.map((key, i) => <span key={key} style={{ color: i < 26 ? palette.letters : i < 36 ? palette.digits : palette.marks }}>{key}</span>)}
      </div>}
    </div>
  </div>
})
