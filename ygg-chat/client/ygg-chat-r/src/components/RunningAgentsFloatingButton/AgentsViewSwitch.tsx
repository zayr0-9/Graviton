import type { CSSProperties } from 'react'
import { LayoutGrid, List } from 'lucide-react'

interface AgentsViewSwitchProps {
  gridView: boolean
  onChange: (grid: boolean) => void
  activeStyle?: CSSProperties
  inactiveStyle?: CSSProperties
}

/** Selection represents the chosen mode, including while inspecting a fork. */
export function AgentsViewSwitch({ gridView, onChange, activeStyle, inactiveStyle }: AgentsViewSwitchProps) {
  return (
    <div role='group' aria-label='Agents view' className='flex items-center gap-1 rounded-full bg-black/5 p-1 dark:bg-white/5'
      onClick={event => event.stopPropagation()}>
      {[{ grid: true, label: 'Live grid view', title: 'Watch agents in live grid', Icon: LayoutGrid },
        { grid: false, label: 'List view', title: 'List view', Icon: List }].map(({ grid, label, title, Icon }) => {
        const active = gridView === grid
        return (
          <button key={label} type='button' aria-label={label} title={title} aria-pressed={active}
            onClick={() => onChange(grid)}
            className={`flex h-10 w-10 items-center justify-center rounded-full transition-[background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${active
              ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100'
              : 'text-neutral-500 hover:bg-white/70 dark:text-neutral-400 dark:hover:bg-white/10'}`}
            style={active ? activeStyle : inactiveStyle}>
            <Icon size={18} strokeWidth={2.25} aria-hidden='true' />
          </button>
        )
      })}
    </div>
  )
}
