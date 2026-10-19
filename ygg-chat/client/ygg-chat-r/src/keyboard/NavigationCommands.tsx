import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useTitleBarHistory } from '../components/TitleBar/useTitleBarHistory'
import { useCommands } from './KeyboardProvider'

const NavigationContext = createContext<ReturnType<typeof useTitleBarHistory> | null>(null)

export const NavigationCommands = ({ children }: { children: ReactNode }) => {
  const history = useTitleBarHistory()
  useCommands([
    // Always consume these chords, even at an endpoint, so native browser history
    // cannot bypass the title-bar exclusions or queue an extra pending jump.
    { id: 'navigation.back', run: history.goBack },
    { id: 'navigation.forward', run: history.goForward },
  ])
  return <NavigationContext.Provider value={history}>{children}</NavigationContext.Provider>
}

export const useAppNavigation = () => {
  const navigation = useContext(NavigationContext)
  if (!navigation) throw new Error('useAppNavigation requires NavigationCommands')
  return navigation
}
