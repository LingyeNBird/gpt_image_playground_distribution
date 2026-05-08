import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { apiRequest, isAuthError } from '../lib/backend'
import { AdminButton, AdminInput, AdminSelect } from './adminUi'

type AdminSettings = { baseUrl: string; apiKey: string; model: string; timeout: number; apiMode: string; codexCli: boolean }

const defaultAdminSettings: AdminSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-2',
  timeout: 300,
  apiMode: 'images',
  codexCli: false,
}

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const currentUser = useStore((s) => s.currentUser)
  const [deliveryMode, setDeliveryMode] = useState(settings.deliveryMode)
  const [adminSettings, setAdminSettings] = useState<AdminSettings>(defaultAdminSettings)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [testing, setTesting] = useState<'url' | 'key' | null>(null)

  useEffect(() => {
    if (showSettings) setDeliveryMode(settings.deliveryMode)
  }, [showSettings, settings.deliveryMode])

  useEffect(() => {
    if (!showSettings || currentUser?.role !== 'admin') return
    setMessage(null)
    apiRequest<AdminSettings>('/api/admin/settings')
      .then((data) => setAdminSettings({ ...defaultAdminSettings, ...data }))
      .catch((err) => {
        if (isAuthError(err)) {
          return
        }
        setMessage({ type: 'error', text: `读取上游设置失败：${err instanceof Error ? err.message : String(err)}` })
      })
  }, [showSettings, currentUser?.role])

  const handleClose = () => {
    setSettings({ deliveryMode })
    setShowSettings(false)
  }

  const saveAdminSettings = async () => {
    await apiRequest('/api/admin/settings', { method: 'PUT', body: JSON.stringify(adminSettings) })
    setSettings({
      baseUrl: adminSettings.baseUrl,
      apiKey: adminSettings.apiKey === '********' ? settings.apiKey : adminSettings.apiKey,
      model: adminSettings.model,
      timeout: adminSettings.timeout,
      apiMode: adminSettings.apiMode === 'responses' ? 'responses' : 'images',
      codexCli: adminSettings.codexCli,
    })
    setMessage({ type: 'success', text: '上游设置已保存' })
  }

  const testAdminSetting = async (kind: 'url' | 'key') => {
    setTesting(kind)
    setMessage({ type: 'info', text: kind === 'url' ? '正在测试上游 API URL…' : '正在验证上游 API Key…' })
    try {
      const endpoint = kind === 'url' ? '/api/admin/settings/test-url' : '/api/admin/settings/verify-key'
      const result = await apiRequest<{ message: string }>(endpoint, { method: 'POST', body: JSON.stringify(adminSettings) })
      setMessage({ type: 'success', text: result.message })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(null)
    }
  }

  useCloseOnEscape(showSettings, handleClose)
  if (!showSettings) return null

  const isAdmin = currentUser?.role === 'admin'
  const canDirect = isAdmin || currentUser?.allowDirect !== false
  const canBucket = isAdmin || currentUser?.allowBucket === true

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" onClick={handleClose} />
      <div className="relative z-10 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">{isAdmin ? '管理员设置' : '用户设置'}</h3>
          <AdminButton onClick={handleClose} variant="ghost" size="icon" className="rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" aria-label="关闭">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </AdminButton>
        </div>
        {message && <div className={`mb-4 rounded-xl px-3 py-2 text-sm ${message.type === 'error' ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300' : message.type === 'info' ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300' : 'bg-green-50 text-green-600 dark:bg-green-500/10 dark:text-green-300'}`}>{message.text}</div>}
        <section>
          <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200">分发模式</h4>
          <div className="space-y-3">
            <label className={`flex items-center justify-between rounded-2xl border p-4 ${!canDirect ? 'opacity-50' : ''}`}>
              <span><span className="block font-medium">直传模式</span><span className="text-xs text-gray-500">后端生成后直接返回图片数据</span></span>
              <input type="radio" name="delivery" checked={deliveryMode === 'direct'} disabled={!canDirect} onChange={() => setDeliveryMode('direct')} />
            </label>
            <label className={`flex items-center justify-between rounded-2xl border p-4 ${!canBucket ? 'opacity-50' : ''}`}>
              <span><span className="block font-medium">存储桶模式</span><span className="text-xs text-gray-500">后端上传 COS，只返回临时链接；关闭页面后仍会继续生成</span></span>
              <input type="radio" name="delivery" checked={deliveryMode === 'bucket'} disabled={!canBucket} onChange={() => setDeliveryMode('bucket')} />
            </label>
          </div>
        </section>
        {isAdmin && (
          <section className="mt-6 border-t border-gray-100 pt-5 dark:border-white/[0.08]">
            <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200">上游接口</h4>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block md:col-span-2">
                <span className="text-xs text-gray-500">上游 API URL</span>
                <div className="mt-1 flex gap-2">
                  <AdminInput name="upstreamBaseUrl" value={adminSettings.baseUrl} onChange={(e) => setAdminSettings({ ...adminSettings, baseUrl: e.target.value })} className="min-w-0 flex-1" />
                  <AdminButton type="button" size="sm" variant="secondary" disabled={testing !== null} onClick={() => testAdminSetting('url')}>{testing === 'url' ? '测试中…' : '测试'}</AdminButton>
                </div>
              </label>
              <label className="block md:col-span-2">
                <span className="text-xs text-gray-500">上游 API Key</span>
                <div className="mt-1 flex gap-2">
                  <AdminInput name="upstreamApiKey" autoComplete="current-password" type="password" value={adminSettings.apiKey} onChange={(e) => setAdminSettings({ ...adminSettings, apiKey: e.target.value })} className="min-w-0 flex-1" />
                  <AdminButton type="button" size="sm" variant="secondary" disabled={testing !== null} onClick={() => testAdminSetting('key')}>{testing === 'key' ? '验证中…' : '验证'}</AdminButton>
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">模型</span>
                <AdminInput name="upstreamModel" value={adminSettings.model} onChange={(e) => setAdminSettings({ ...adminSettings, model: e.target.value })} className="mt-1" />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">超时秒数</span>
                <AdminInput name="upstreamTimeout" type="number" value={adminSettings.timeout} onChange={(e) => setAdminSettings({ ...adminSettings, timeout: Number(e.target.value) })} className="mt-1" />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">接口模式</span>
                <AdminSelect name="upstreamApiMode" value={adminSettings.apiMode} onChange={(e) => setAdminSettings({ ...adminSettings, apiMode: e.target.value })} className="mt-1">
                  <option value="images">Images API</option>
                  <option value="responses">Responses API</option>
                </AdminSelect>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={adminSettings.codexCli} onChange={(e) => setAdminSettings({ ...adminSettings, codexCli: e.target.checked })} />
                Codex CLI 兼容
              </label>
            </div>
            <AdminButton onClick={saveAdminSettings} variant="primary" className="mt-4">保存上游设置</AdminButton>
          </section>
        )}
      </div>
    </div>
  )
}
