import type { FastModeAnimation as Animation } from '../../helpers/fastModeAnimationSettings'
import type { CustomChatTheme } from '../ThemeManager/themeConfig'
import { getFastModePalette } from './fastModePalette'
import './fastModeAnimation.css'

const contourPath = 'M0 0Q150 160 270 40T540 0M0 12Q150 172 270 52T540 12M0 24Q150 184 270 64T540 24M0 36Q150 196 270 76T540 36M0 48Q150 208 270 88T540 48M0 60Q150 220 270 100T540 60M0 72Q150 232 270 112T540 72M0 84Q150 244 270 124T540 84M0 -12Q150 148 270 28T540 -12M0 -24Q150 136 270 16T540 -24'
const causticPaths = [
  'M-20 30C40 0 65 80 120 46S185 8 222 38S290 94 340 48S390 2 440 35M-20 94C30 145 86 40 134 84S194 148 248 104S318 48 364 100S410 138 440 90M20-10C70 20 4 65 50 100S115 150 80 190M178-20C210 24 140 50 182 92S246 140 212 190M328-20C284 18 360 62 326 98S270 148 310 190',
  'M-20 14C54 68 80 0 140 36S204 100 266 52S344-8 440 42M-20 126C50 74 72 160 146 122S224 64 292 130S372 166 440 116M118-20C72 34 156 66 124 118S88 150 140 190M270-20C232 30 302 68 270 122S216 152 262 190',
]
const counts: Partial<Record<Animation, number>> = {
  aurora: 3, slipstream: 4, solar: 3, ribbon: 3, ripple: 3, 'sea-glass': 3,
  'tidal-glass': 3, 'pixel-packets': 4, 'pixel-rain': 7, 'caustic-tide': 1,
}

export const FastModeAnimationBackground = ({ animation, dark, theme }: {
  animation: Animation
  dark: boolean
  theme?: CustomChatTheme
}) => {
  if (animation === 'none') return null
  return (
    <span className='fm-background' aria-hidden='true' style={getFastModePalette(animation, dark, theme)}>
      {/* Match the approved study's geometry at any composer size, without resize listeners. */}
      <svg className='fm-viewport' viewBox='0 0 264 76' preserveAspectRatio='none'>
        <foreignObject width='264' height='76'>
          <div className={`fm-scene fm-${animation}`}>
            {animation === 'slipstream' && <div className='fm-tracks' />}
            {Array.from({ length: counts[animation] || 2 }, (_, index) => <i key={index} />)}
            {animation === 'contour' && [0, 1].map(index => (
              <svg key={index} viewBox='0 0 540 160'><path d={contourPath} /></svg>
            ))}
            {animation === 'caustic-tide' && causticPaths.map(path => (
              <svg key={path} viewBox='0 0 420 170'><path d={path} /></svg>
            ))}
          </div>
        </foreignObject>
      </svg>
    </span>
  )
}
