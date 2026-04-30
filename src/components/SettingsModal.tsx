import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const currentUser = useStore((s) => s.currentUser)
  const [deliveryMode, setDeliveryMode] = useState(settings.deliveryMode)

  useEffect(() => {
    if (showSettings) setDeliveryMode(settings.deliveryMode)
  }, [showSettings, settings.deliveryMode])

  const handleClose = () => {
    setSettings({ deliveryMode })
    setShowSettings(false)
  }

  useCloseOnEscape(showSettings, handleClose)
  if (!showSettings) return null

  const canDirect = currentUser?.allowDirect !== false
  const canBucket = currentUser?.allowBucket === true

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">用户设置</h3>
          <button onClick={handleClose} className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200" aria-label="关闭">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
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
      </div>
    </div>
  )
}
