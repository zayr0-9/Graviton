import { Analytics } from '@vercel/analytics/react'
import { AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useRef } from 'react'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from './components/ThemeManager/themeConfig'
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { HtmlIframeRegistryProvider, useHtmlIframeRegistry } from './components/HtmlIframeRegistry/HtmlIframeRegistry'
import { GlobalNotifications } from './components/GlobalNotifications/GlobalNotifications'
import { HtmlToolsModal } from './components/HtmlToolsModal/HtmlToolsModal'
import { RunningAgentsFloatingButton } from './components/RunningAgentsFloatingButton'
import { LiquidGlassSVG } from './components/LiquidGlassSVG'
import ProtectedRoute from './components/ProtectedRoute'
import { TitleBar } from './components/TitleBar/TitleBar'
import { UpdateModal } from './components/UpdateModal/UpdateModal'
import VideoBackground from './components/VideoBackground'
import {
  BlogPage,
  Chat,
  ConversationPage,
  FAQPage,
  HomepageRedirect,
  LandingPage,
  LoggingPage,
  Login,
  PaymentPage,
  PaymentPlans,
  PrivacyPolicy,
  RecentLineages,
  RefundPolicy,
  Settings,
  TermsOfService,
} from './containers'
import RightBar from './containers/rightBar'
import SideBar from './containers/sideBar'
import { selectCcCwd, selectCurrentConversationId } from './features/chats'
import { selectCurrentUser } from './features/users'
import { useAppSelector } from './hooks/redux'
import { useIsMobile } from './hooks/useMediaQuery'
import { useResearchNotes } from './hooks/useQueries'
import { dispatchChatInsertFilePath } from './helpers/chatInputBridge'
import IdeContextBootstrap from './IdeContextBootstrap'

// Use HashRouter for Electron (file:// protocol requires hash-based routing)
// Use BrowserRouter for web (standard HTML5 history API)
const isElectron =
  (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) || import.meta.env.VITE_ENVIRONMENT === 'electron'

const Router = isElectron ? HashRouter : BrowserRouter

const TOOL_VIEWER_HIDDEN_ROUTES = new Set([
  '/',
  '/landingpage',
  '/login',
  '/faq',
  '/paymentplan',
  '/payment',
  '/terms',
  '/refund-policy',
  '/privacy',
  '/blog',
])

const RIGHTBAR_HIDDEN_ROUTES = new Set([
  '/',
  '/landingpage',
  '/login',
  '/faq',
  '/paymentplan',
  '/blog',
  '/settings',
  '/terms',
  '/refund-policy',
  '/privacy',
  '/infrastructure',
  '/logging',
])

const CHAT_ROUTE_PATTERN = /^\/chat\/[^/]+\/[^/]+(?:\/lineage\/[^/]+)?$/
const RECENT_LINEAGES_ROUTE_PATTERN = /^\/projects\/[^/]+\/lineages\/recent$/

const SIDEBAR_VISIBLE_ROUTE_PATTERNS = [
  /^\/homepage$/,
  /^\/conversationPage$/,
  CHAT_ROUTE_PATTERN,
  RECENT_LINEAGES_ROUTE_PATTERN,
  /^\/logging$/,
]

const getRouteAnimationKey = (pathname: string) => {
  if (CHAT_ROUTE_PATTERN.test(pathname)) {
    return '/chat/:projectId/:id'
  }

  return pathname
}

const HtmlToolsShell = ({ enabled }: { enabled: boolean }) => {
  const location = useLocation()
  const registry = useHtmlIframeRegistry()
  const currentUser = useAppSelector(selectCurrentUser)
  const isMobile = useIsMobile()
  const { data: notes = [] } = useResearchNotes()
  const isHiddenRoute = TOOL_VIEWER_HIDDEN_ROUTES.has(location.pathname)
  const canShow = Boolean(enabled && registry && currentUser && !isHiddenRoute)
  const bootstrappedUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!registry || !enabled || !currentUser || bootstrappedUserIdRef.current === currentUser.id) return
    bootstrappedUserIdRef.current = currentUser.id
    registry.bootstrapFromLocalCache(currentUser.id)
  }, [currentUser, enabled, registry])

  useEffect(() => {
    if (!registry || !enabled || !currentUser) return
    if (!registry.isModalOpen || registry.entries.length > 0) return
    registry.bootstrapFromLocalCache(currentUser.id)
  }, [currentUser, enabled, registry])

  useEffect(() => {
    if (!registry || !registry.isModalOpen) return
    if (!enabled || !currentUser || isHiddenRoute) {
      registry.closeModal()
    }
  }, [currentUser, enabled, isHiddenRoute, registry])

  if (!canShow || !registry) return null

  const isHomepageFullscreen = registry.isHomepageFullscreen

  const toggleAppsModal = () => {
    if (registry.isModalOpen) {
      registry.closeModal()
      return
    }
    registry.openModal()
  }

  return (
    <>
      <HtmlToolsModal />
      {!isHomepageFullscreen && (
        <RunningAgentsFloatingButton
          notes={notes}
          onOpenApps={toggleAppsModal}
          appsOpen={registry.isModalOpen}
          className={isMobile ? 'bottom-32 right-5' : 'bottom-6 right-14'}
        />
      )}
    </>
  )
}

const SideBarShell = () => {
  const location = useLocation()
  const isMobile = useIsMobile()
  const currentUser = useAppSelector(selectCurrentUser)
  const currentConversationId = useAppSelector(selectCurrentConversationId)

  if (!currentUser || isMobile) return null

  const isVisibleRoute = SIDEBAR_VISIBLE_ROUTE_PATTERNS.some(pattern => pattern.test(location.pathname))

  return <SideBar limit={120} activeConversationId={currentConversationId} className={isVisibleRoute ? '' : 'hidden'} />
}

const RightBarShell = () => {
  const location = useLocation()
  const isMobile = useIsMobile()
  const currentConversationId = useAppSelector(selectCurrentConversationId)
  const ccCwd = useAppSelector(selectCcCwd)
  const { data: notes = [], isLoading: isLoadingNotes } = useResearchNotes()
  const isChatRoute = CHAT_ROUTE_PATTERN.test(location.pathname)

  const handleFilePathInsert = useCallback((path: string) => {
    dispatchChatInsertFilePath(path)
  }, [])

  if (isMobile) return null
  if (RIGHTBAR_HIDDEN_ROUTES.has(location.pathname) || RECENT_LINEAGES_ROUTE_PATTERN.test(location.pathname))
    return null

  return (
    <RightBar
      conversationId={isChatRoute ? currentConversationId : null}
      notes={notes}
      isLoadingNotes={isLoadingNotes}
      ccCwd={isChatRoute ? ccCwd : ''}
      onFilePathInsert={isChatRoute ? handleFilePathInsert : undefined}
    />
  )
}

function AnimatedRoutes() {
  const location = useLocation()

  return (
    <AnimatePresence mode='popLayout'>
      <Routes location={location} key={getRouteAnimationKey(location.pathname)}>
        {/* Public route */}
        <Route path='/landingpage' element={<LandingPage />} />
        {/* Public route */}
        <Route path='/faq' element={<FAQPage />} />
        {/* Public route */}
        <Route path='/login' element={<Login />} />
        {/* Public route */}
        <Route path='/paymentplan' element={<PaymentPlans />} />
        {/* Public route */}
        <Route path='/terms' element={<TermsOfService />} />
        {/* Public route */}
        <Route path='/refund-policy' element={<RefundPolicy />} />
        {/* Public route */}
        <Route path='/privacy' element={<PrivacyPolicy />} />
        {/* Public route */}
        <Route path='/blog' element={<BlogPage />} />
        {/* Protected routes */}
        <Route
          path='/conversationPage'
          element={
            <ProtectedRoute>
              <ConversationPage />
            </ProtectedRoute>
          }
        />
        <Route path='/' element={isElectron ? <Navigate to='/login' replace /> : <LandingPage />} />
        <Route
          path='/homepage'
          element={
            <ProtectedRoute>
              <HomepageRedirect />
            </ProtectedRoute>
          }
        />
        <Route
          path='/chat/:projectId/:id'
          element={
            <ProtectedRoute>
              <Chat />
            </ProtectedRoute>
          }
        />
        <Route
          path='/chat/:projectId/:id/lineage/:lineageId'
          element={
            <ProtectedRoute>
              <Chat />
            </ProtectedRoute>
          }
        />
        <Route
          path='/projects/:projectId/lineages/recent'
          element={
            isElectron ? (
              <ProtectedRoute>
                <RecentLineages />
              </ProtectedRoute>
            ) : (
              <Navigate to='/homepage' replace />
            )
          }
        />
        <Route
          path='/settings'
          element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          }
        />
        <Route
          path='/payment'
          element={
            <ProtectedRoute>
              <PaymentPage />
            </ProtectedRoute>
          }
        />
        <Route
          path='/logging'
          element={
            <ProtectedRoute>
              <LoggingPage />
            </ProtectedRoute>
          }
        />

        {/* Fallback */}
        <Route path='*' element={<Navigate to='/' replace />} />
      </Routes>
    </AnimatePresence>
  )
}

const GlobalCustomThemeCssVariables = () => {
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  useEffect(() => {
    if (typeof document === 'undefined') return

    const rootStyle = document.documentElement.style
    const variableNames = [
      '--thin-scrollbar-thumb',
      '--thin-scrollbar-thumb-hover',
      '--thin-scrollbar-track',
      '--thin-scrollbar-shadow',
    ]

    if (!customThemeEnabled) {
      variableNames.forEach(name => rootStyle.removeProperty(name))
      return
    }

    rootStyle.setProperty('--thin-scrollbar-thumb', getThemeModeColor(customTheme.colors.thinScrollbarThumb, isDarkMode))
    rootStyle.setProperty(
      '--thin-scrollbar-thumb-hover',
      getThemeModeColor(customTheme.colors.thinScrollbarThumbHover, isDarkMode)
    )
    rootStyle.setProperty('--thin-scrollbar-track', getThemeModeColor(customTheme.colors.thinScrollbarTrack, isDarkMode))
    rootStyle.setProperty('--thin-scrollbar-shadow', getThemeModeColor(customTheme.colors.thinScrollbarShadow, isDarkMode))

    return () => {
      variableNames.forEach(name => rootStyle.removeProperty(name))
    }
  }, [customTheme, customThemeEnabled, isDarkMode])

  return null
}

function App() {
  const currentUser = useAppSelector(selectCurrentUser)
  const resetKey = currentUser?.id ?? null

  const appShell = (
    <>
      {/* Custom title bar for Windows Electron */}
      <TitleBar />
      {/* Persistent custom theme CSS variables */}
      <GlobalCustomThemeCssVariables />
      {/* Persistent app background across all routes */}
      <VideoBackground />
      {/* SVG filters for liquid glass effect */}
      <LiquidGlassSVG />
      {/* Establish IDE Context WebSocket globally so it's not tied to any specific page */}
      <IdeContextBootstrap />
      {/* Global update modal for Electron auto-updates */}
      <UpdateModal />
      <div className='app-content'>
        <SideBarShell />
        <div className='app-main'>
          <AnimatedRoutes />
        </div>
        <RightBarShell />
      </div>
      <HtmlToolsShell enabled={isElectron} />
      <GlobalNotifications />
    </>
  )

  return (
    <>
      <Router>
        {isElectron ? (
          <HtmlIframeRegistryProvider resetKey={resetKey}>{appShell}</HtmlIframeRegistryProvider>
        ) : (
          appShell
        )}
      </Router>
      {!isElectron && <Analytics />}
    </>
  )
}

export default App
