import { useState } from 'react'
import { loginAdmin, loginUser, registerUser } from '../lib/backend'
import { useStore } from '../store'

export default function LoginPage() {
  const setCurrentUser = useStore((s) => s.setCurrentUser)
  const [tab, setTab] = useState<'login' | 'register' | 'admin'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [adminKey, setAdminKey] = useState('')
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const user = tab === 'admin'
        ? await loginAdmin(adminKey)
        : tab === 'register'
          ? await registerUser(username, password)
          : await loginUser(username, password)
      setCurrentUser(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-3xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 p-6 shadow-xl">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-1">GPT Image Playground</h1>
        <p className="text-sm text-gray-500 mb-5">请登录后使用分发服务</p>
        <div className="grid grid-cols-3 gap-2 mb-5 text-sm">
          {(['login','register','admin'] as const).map((item) => (
            <button key={item} type="button" onClick={() => setTab(item)} className={`rounded-xl px-3 py-2 ${tab === item ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300'}`}>
              {item === 'login' ? '登录' : item === 'register' ? '注册' : '管理员'}
            </button>
          ))}
        </div>
        {tab === 'admin' ? (
          <label className="block mb-4">
            <span className="text-xs text-gray-500">管理员密钥</span>
            <input name="adminKey" autoComplete="current-password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} type="password" className="mt-1 w-full rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-3 py-2 outline-none" />
          </label>
        ) : (
          <>
            <label className="block mb-3">
              <span className="text-xs text-gray-500">用户名</span>
              <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-3 py-2 outline-none" />
            </label>
            <label className="block mb-4">
              <span className="text-xs text-gray-500">密码</span>
              <input name="password" autoComplete={tab === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="mt-1 w-full rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] px-3 py-2 outline-none" />
            </label>
          </>
        )}
        {error && <p className="mb-3 rounded-xl bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}
        <button className="w-full rounded-xl bg-blue-500 px-4 py-2.5 text-white font-medium hover:bg-blue-600 transition">
          {tab === 'register' ? '注册并登录' : '登录'}
        </button>
      </form>
    </div>
  )
}
