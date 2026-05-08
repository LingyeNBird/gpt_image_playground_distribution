import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { normalizeBaseUrl } from './lib/api'
import { AUTH_INVALIDATED_EVENT } from './lib/backend'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { ApiMode } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import LoginPage from './components/LoginPage'
import AdminPanel from './components/AdminPanel'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const setCurrentUser = useStore((s) => s.setCurrentUser)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const currentUser = useStore((s) => s.currentUser)
  const authChecked = useStore((s) => s.authChecked)
  const [pathname, setPathname] = useState(() => window.location.pathname)
  useDockerApiUrlMigrationNotice()

  const showAdminPanel = currentUser?.role === 'admin' && pathname === '/admin'

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings: { baseUrl?: string; apiKey?: string; codexCli?: boolean; apiMode?: ApiMode } = {}

    const apiUrlParam = searchParams.get('apiUrl')
    if (apiUrlParam !== null) {
      nextSettings.baseUrl = normalizeBaseUrl(apiUrlParam.trim())
    }

    const apiKeyParam = searchParams.get('apiKey')
    if (apiKeyParam !== null) {
      nextSettings.apiKey = apiKeyParam.trim()
    }

    const codexCliParam = searchParams.get('codexCli')
    if (codexCliParam !== null) {
      nextSettings.codexCli = codexCliParam.trim().toLowerCase() === 'true'
    }

    const apiModeParam = searchParams.get('apiMode')
    if (apiModeParam === 'images' || apiModeParam === 'responses') {
      nextSettings.apiMode = apiModeParam
    }

    setSettings(nextSettings)

    if (searchParams.has('apiUrl') || searchParams.has('apiKey') || searchParams.has('codexCli') || searchParams.has('apiMode')) {
      searchParams.delete('apiUrl')
      searchParams.delete('apiKey')
      searchParams.delete('codexCli')
      searchParams.delete('apiMode')

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    const syncPathname = () => setPathname(window.location.pathname)

    window.addEventListener('popstate', syncPathname)
    return () => window.removeEventListener('popstate', syncPathname)
  }, [])

  useEffect(() => {
    const handleAuthInvalidated = () => {
      setCurrentUser(null)
      setShowSettings(false)
    }

    window.addEventListener(AUTH_INVALIDATED_EVENT, handleAuthInvalidated)
    return () => window.removeEventListener(AUTH_INVALIDATED_EVENT, handleAuthInvalidated)
  }, [setCurrentUser, setShowSettings])

  useEffect(() => {
    if (!authChecked) return

    if (!currentUser) {
      if (pathname !== '/' && pathname !== '/admin') {
        window.history.replaceState(null, '', '/')
        setPathname('/')
      }
      return
    }

    if (!currentUser) return

    if (currentUser.role !== 'admin' && pathname === '/admin') {
      window.history.replaceState(null, '', '/')
      setPathname('/')
      return
    }

    if (pathname !== '/' && pathname !== '/admin') {
      const nextPath = currentUser.role === 'admin' ? pathname : '/'
      if (nextPath !== pathname) {
        window.history.replaceState(null, '', nextPath)
        setPathname(nextPath)
      }
    }
  }, [authChecked, currentUser, pathname])

  const navigateTo = (nextPath: '/' | '/admin') => {
    if (window.location.pathname === nextPath) return
    window.history.pushState(null, '', nextPath)
    setPathname(nextPath)
  }

  if (!authChecked) {
    return <div className="min-h-screen grid place-items-center text-gray-400">加载中...</div>
  }

  if (!currentUser) return <LoginPage />

  return (
    <>
      <Header
        adminButtonLabel={showAdminPanel ? '生图页' : '后台'}
        onOpenAdmin={currentUser.role === 'admin' ? () => navigateTo(showAdminPanel ? '/' : '/admin') : undefined}
      />
      {currentUser.role === 'admin' && showAdminPanel ? (
        <AdminPanel />
      ) : (
        <>
          <main data-home-main data-drag-select-surface className="pb-48">
            <div className="safe-area-x max-w-7xl mx-auto">
              <SearchBar />
              <TaskGrid />
            </div>
          </main>
          <InputBar />
          <DetailModal />
          <Lightbox />
        </>
      )}
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      {!(currentUser.role === 'admin' && showAdminPanel) && <MaskEditorModal />}
      {!(currentUser.role === 'admin' && showAdminPanel) && <ImageContextMenu />}
    </>
  )
}
