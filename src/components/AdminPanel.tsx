import { useEffect, useState } from 'react'
import { apiRequest, logout } from '../lib/backend'
import { useStore } from '../store'

type AdminSettings = { baseUrl: string; apiKey: string; model: string; timeout: number; apiMode: string; codexCli: boolean }
type AdminUser = { id: string; username: string; disabled: boolean; banned: boolean; quotaTotal: number; quotaUsed: number; quotaRemaining: number; allowDirect: boolean; allowBucket: boolean; online: boolean; runningTasks: number }
type Bucket = { id: string; name: string; bucketUrl: string; pathPrefix: string; tempUrlMinutes: number; imageCount: number }
type Failure = { id: string; username: string; prompt: string; error: string; createdAt: number }

export default function AdminPanel() {
  const setCurrentUser = useStore((s) => s.setCurrentUser)
  const [tab, setTab] = useState<'users' | 'storage' | 'settings'>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [failures, setFailures] = useState<Failure[]>([])
  const [settings, setSettings] = useState<AdminSettings>({ baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-2', timeout: 300, apiMode: 'images', codexCli: false })
  const [message, setMessage] = useState('')

  const load = async () => {
    const [u, b, f, s] = await Promise.all([
      apiRequest<{ users: AdminUser[] }>('/api/admin/users'),
      apiRequest<{ buckets: Bucket[] }>('/api/admin/buckets'),
      apiRequest<{ failures: Failure[] }>('/api/admin/failures'),
      apiRequest<AdminSettings>('/api/admin/settings'),
    ])
    setUsers(u.users); setBuckets(b.buckets); setFailures(f.failures); setSettings(s)
  }

  useEffect(() => { void load() }, [])

  const patchUser = async (id: string, patch: Partial<AdminUser>) => {
    await apiRequest(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    await load()
  }

  const saveSettings = async () => {
    await apiRequest('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) })
    setMessage('设置已保存')
  }

  const addBucket = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    await apiRequest('/api/admin/buckets', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd.entries())) })
    e.currentTarget.reset()
    await load()
  }

  const doLogout = async () => { await logout(); setCurrentUser(null) }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-800 dark:text-gray-100">
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-gray-900/90 border-b border-gray-200 dark:border-white/[0.08] backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="font-bold">分发管理</h1>
          <button onClick={doLogout} className="rounded-xl bg-gray-100 dark:bg-white/[0.06] px-3 py-1.5 text-sm">退出</button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-4">
        <div className="flex gap-2 mb-4">
          {(['users','storage','settings'] as const).map((item) => <button key={item} onClick={() => setTab(item)} className={`rounded-xl px-4 py-2 text-sm ${tab === item ? 'bg-blue-500 text-white' : 'bg-white dark:bg-gray-900'}`}>{item === 'users' ? '用户管理' : item === 'storage' ? '存储设置' : '上游设置'}</button>)}
        </div>
        {message && <div className="mb-4 rounded-xl bg-green-50 text-green-600 px-4 py-2 text-sm">{message}</div>}
        {tab === 'users' && <UsersTab users={users} failures={failures} patchUser={patchUser} reload={load} />}
        {tab === 'storage' && <StorageTab buckets={buckets} addBucket={addBucket} />}
        {tab === 'settings' && <SettingsTab settings={settings} setSettings={setSettings} save={saveSettings} />}
      </main>
    </div>
  )
}

function UsersTab({ users, failures, patchUser, reload }: { users: AdminUser[]; failures: Failure[]; patchUser: (id: string, patch: Partial<AdminUser>) => Promise<void>; reload: () => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const addUser = async () => { await apiRequest('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, quotaTotal: 0 }) }); setUsername(''); setPassword(''); await reload() }
  return <div className="space-y-4">
    <div className="rounded-2xl bg-white dark:bg-gray-900 p-4 flex gap-2 flex-wrap">
      <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} className="rounded-xl border px-3 py-2 bg-transparent" />
      <input placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="rounded-xl border px-3 py-2 bg-transparent" />
      <button onClick={addUser} className="rounded-xl bg-blue-500 text-white px-4 py-2">添加用户</button>
    </div>
    <div className="overflow-x-auto rounded-2xl bg-white dark:bg-gray-900">
      <table className="w-full text-sm"><thead><tr className="text-left text-gray-500"><th className="p-3">用户</th><th>状态</th><th>生成中</th><th>额度</th><th>模式</th><th>操作</th></tr></thead><tbody>{users.map((u) => <tr key={u.id} className="border-t border-gray-100 dark:border-white/[0.08]"><td className="p-3">{u.username}</td><td>{u.online ? '在线' : '离线'} {u.disabled ? '禁用' : ''} {u.banned ? '封禁' : ''}</td><td>{u.runningTasks}</td><td><input type="number" defaultValue={u.quotaTotal} onBlur={(e) => patchUser(u.id, { quotaTotal: Number(e.target.value) })} className="w-20 rounded border bg-transparent px-2 py-1" /> 已用 {u.quotaUsed} 剩 {u.quotaRemaining}</td><td><label><input type="checkbox" checked={u.allowDirect} onChange={(e) => patchUser(u.id, { allowDirect: e.target.checked })} /> 直传</label> <label><input type="checkbox" checked={u.allowBucket} onChange={(e) => patchUser(u.id, { allowBucket: e.target.checked })} /> 存储桶</label></td><td><button onClick={() => patchUser(u.id, { disabled: !u.disabled })} className="mr-2 text-blue-500">{u.disabled ? '启用' : '禁用'}</button><button onClick={() => patchUser(u.id, { banned: !u.banned })} className="text-red-500">{u.banned ? '解封' : '封禁'}</button></td></tr>)}</tbody></table>
    </div>
    <div className="rounded-2xl bg-white dark:bg-gray-900 p-4"><h2 className="font-semibold mb-3">失败日志</h2>{failures.map((f) => <div key={f.id} className="border-t border-gray-100 dark:border-white/[0.08] py-3 text-sm"><div className="text-gray-500">{new Date(f.createdAt).toLocaleString()} · {f.username}</div><div>提示词：{f.prompt}</div><div className="text-red-500 break-all">{f.error}</div></div>)}</div>
  </div>
}

function StorageTab({ buckets, addBucket }: { buckets: Bucket[]; addBucket: (e: React.FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <div className="space-y-4"><form onSubmit={addBucket} className="rounded-2xl bg-white dark:bg-gray-900 p-4 grid gap-3 md:grid-cols-2"><input name="name" placeholder="名称" className="rounded-xl border bg-transparent px-3 py-2" /><input name="bucketUrl" placeholder="Bucket URL，例如 https://xxx.cos.ap-guangzhou.myqcloud.com" className="rounded-xl border bg-transparent px-3 py-2" /><input name="secretId" placeholder="SecretId" className="rounded-xl border bg-transparent px-3 py-2" /><input name="secretKey" placeholder="SecretKey" type="password" className="rounded-xl border bg-transparent px-3 py-2" /><input name="pathPrefix" placeholder="路径前缀 images" className="rounded-xl border bg-transparent px-3 py-2" /><input name="tempUrlMinutes" placeholder="临时链接分钟数" type="number" className="rounded-xl border bg-transparent px-3 py-2" /><button className="rounded-xl bg-blue-500 text-white px-4 py-2">添加存储桶</button></form><div className="grid gap-3">{buckets.map((b) => <div key={b.id} className="rounded-2xl bg-white dark:bg-gray-900 p-4"><div className="font-medium">{b.name}</div><div className="text-sm text-gray-500">{b.bucketUrl} · {b.imageCount} 张图</div></div>)}</div></div>
}

function SettingsTab({ settings, setSettings, save }: { settings: AdminSettings; setSettings: (s: AdminSettings) => void; save: () => Promise<void> }) {
  const field = (key: keyof AdminSettings, label: string, type = 'text') => <label className="block"><span className="text-xs text-gray-500">{label}</span><input type={type} value={String(settings[key] ?? '')} onChange={(e) => setSettings({ ...settings, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2" /></label>
  return <div className="rounded-2xl bg-white dark:bg-gray-900 p-4 max-w-xl space-y-3">{field('baseUrl','上游 API URL')}{field('apiKey','上游 API Key','password')}{field('model','模型')}{field('timeout','超时秒数','number')}<label className="block"><span className="text-xs text-gray-500">接口模式</span><select value={settings.apiMode} onChange={(e) => setSettings({ ...settings, apiMode: e.target.value })} className="mt-1 w-full rounded-xl border bg-transparent px-3 py-2"><option value="images">Images API</option><option value="responses">Responses API</option></select></label><label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.codexCli} onChange={(e) => setSettings({ ...settings, codexCli: e.target.checked })} /> Codex CLI 兼容</label><button onClick={save} className="rounded-xl bg-blue-500 text-white px-4 py-2">保存</button></div>
}
