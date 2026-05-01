import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { apiRequest } from '../lib/backend'

type AdminUser = { id: string; username: string; disabled: boolean; banned: boolean; quotaTotal: number; quotaUsed: number; quotaRemaining: number; allowDirect: boolean; allowBucket: boolean; online: boolean; runningTasks: number }
type Bucket = { id: string; name: string; bucketUrl: string; pathPrefix: string; tempUrlMinutes: number; imageCount: number }
type Failure = { id: string; username: string; prompt: string; error: string; createdAt: number }
type AuditEntry = { id: string; type: string; title: string; detail: string; userId?: string; username?: string; createdAt: number }
type AuditPage = { audit: AuditEntry[]; total: number; offset: number; limit: number; hasMore: boolean }
type UpdateInfo = { currentVersion: string; latestVersion: string; updateAvailable: boolean; assetName?: string }
type UpdateCheck = { backend: UpdateInfo; frontend: UpdateInfo }

const surfaceLow = '#f3f3fe'
const surfaceLowest = '#ffffff'
const surfaceBright = '#faf8ff'
const surface = '#faf8ff'
const outline = '#c3c6d7'
const onSurface = '#191b23'
const onSurfaceVariant = '#434655'
const primary = '#004ac6'
const auditPageSize = 30
const inputClass = 'h-[42px] w-full rounded border border-[#c3c6d7] bg-[#f3f3fe] px-4 py-2 text-sm text-[#191b23] outline-none transition-colors placeholder:text-[#737686] focus:border-[#191b23] focus:ring-1 focus:ring-[#191b23]'
const primaryButton = 'h-[42px] rounded bg-[#191b23] px-6 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60'
const quietButton = 'h-[42px] rounded border border-[#c3c6d7] bg-white px-6 py-2 text-sm font-medium text-[#434655] transition-colors hover:bg-[#faf8ff]'

export default function AdminPanel() {
  const [tab, setTab] = useState<'users' | 'storage' | 'updates'>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [failures, setFailures] = useState<Failure[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [auditHasMore, setAuditHasMore] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [usersLoading, setUsersLoading] = useState(true)
  const [usersError, setUsersError] = useState('')

  const loadAuditPage = useCallback(async (offset: number) => {
    setAuditLoading(true)
    try {
      const page = await apiRequest<AuditPage>(`/api/admin/audit?offset=${offset}&limit=${auditPageSize}`)
      setAudit((current) => {
        const next = offset === 0 ? [] : [...current]
        const seen = new Set(next.map((item) => item.id))
        for (const item of page.audit ?? []) {
          if (!seen.has(item.id)) next.push(item)
        }
        return next
      })
      setAuditHasMore(Boolean(page.hasMore))
    } finally {
      setAuditLoading(false)
    }
  }, [])

  const refreshAudit = useCallback(async () => {
    await loadAuditPage(0)
  }, [loadAuditPage])

  const loadUsers = async () => {
    setUsersLoading(true)
    setUsersError('')
    try {
      const payload = await apiRequest<{ users: AdminUser[] }>('/api/admin/users')
      setUsers(payload.users ?? [])
    } catch (err) {
      setUsersError(err instanceof Error ? err.message : String(err))
    } finally {
      setUsersLoading(false)
    }
  }

  const load = async () => {
    await Promise.all([
      loadUsers(),
      apiRequest<{ buckets: Bucket[] }>('/api/admin/buckets').then((b) => setBuckets(b.buckets ?? [])).catch(() => setBuckets([])),
      apiRequest<{ failures: Failure[] }>('/api/admin/failures').then((f) => setFailures(f.failures ?? [])).catch(() => setFailures([])),
      refreshAudit().catch(() => { setAudit([]); setAuditHasMore(false) }),
    ])
  }

  useEffect(() => { void load() }, [])

  const stats = useMemo(() => ({
    online: users.filter((u) => u.online).length,
    running: users.reduce((sum, u) => sum + u.runningTasks, 0),
    remaining: users.reduce((sum, u) => sum + u.quotaRemaining, 0),
    images: buckets.reduce((sum, b) => sum + b.imageCount, 0),
  }), [users, buckets])

  const patchUser = async (id: string, patch: Partial<AdminUser>) => {
    const result = await apiRequest<{ user: AdminUser }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    if (result.user) {
      setUsers((current) => current.map((user) => user.id === id ? result.user : user))
    }
    void refreshAudit().catch(() => undefined)
  }

  const addBucket = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    await apiRequest('/api/admin/buckets', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd.entries())) })
    e.currentTarget.reset()
    await load()
  }

  return (
    <div className="min-h-screen bg-[#f3f3fe] text-[#191b23]" style={{ fontFamily: 'Manrope, var(--font-ui-sans)' }}>
      <main className="mx-auto max-w-[1440px] px-8 py-10 pb-48">
      <div className="mb-6">
        <h2 className="mb-1 text-[32px] font-bold leading-[1.2] tracking-[-0.02em] text-[#191b23]">分发管理</h2>
        <p className="text-base leading-[1.6] text-[#434655]">管理用户额度、COS 存储与系统更新。</p>
      </div>

      <div className="mb-10 flex gap-1 border-b border-[#c3c6d7]">
        {(['users','storage','updates'] as const).map((item) => (
          <button key={item} onClick={() => setTab(item)} className={`px-4 py-2 text-sm font-medium leading-none transition-colors ${tab === item ? 'border-b-2 border-[#191b23] text-[#191b23]' : 'text-[#434655] hover:text-[#191b23]'}`}>
            {item === 'users' ? '用户' : item === 'storage' ? '存储' : '更新'}
          </button>
        ))}
      </div>

      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-4">
        <StatCard label="在线用户" value={stats.online} icon="person" />
        <StatCard label="生成中" value={stats.running} icon="autorenew" />
        <StatCard label="剩余额度" value={stats.remaining} icon="account_balance_wallet" />
        <StatCard label="桶内图片" value={stats.images} icon="image" />
      </div>

      {message && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300">{message}</div>}

        {tab === 'users' && <UsersTab users={users} audit={audit} failures={failures} usersLoading={usersLoading} usersError={usersError} auditLoading={auditLoading} auditHasMore={auditHasMore} patchUser={patchUser} reload={loadUsers} setUsers={setUsers} refreshAudit={refreshAudit} loadOlderAudit={() => loadAuditPage(audit.length)} />}
      {tab === 'storage' && <StorageTab buckets={buckets} addBucket={addBucket} />}
      {tab === 'updates' && <UpdatesTab setGlobalMessage={setMessage} />}
      </main>
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return <div className="flex min-h-[116px] flex-col justify-between rounded-xl border border-[#c3c6d7] bg-white p-6">
    <div className="mb-2 flex items-start justify-between gap-4">
      <span className="text-xs font-bold uppercase leading-none tracking-wider text-[#434655]">{label}</span>
      <MaterialLikeIcon name={icon} className="text-[#004ac6]" />
    </div>
    <div className="text-[32px] font-bold leading-[1.2] tracking-[-0.02em] text-[#191b23]">{value}</div>
  </div>
}

function MaterialLikeIcon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>
}

function UsersTab({ users, audit, failures, usersLoading, usersError, auditLoading, auditHasMore, patchUser, reload, setUsers, refreshAudit, loadOlderAudit }: { users: AdminUser[]; audit: AuditEntry[]; failures: Failure[]; usersLoading: boolean; usersError: string; auditLoading: boolean; auditHasMore: boolean; patchUser: (id: string, patch: Partial<AdminUser>) => Promise<void>; reload: () => Promise<void>; setUsers: React.Dispatch<React.SetStateAction<AdminUser[]>>; refreshAudit: () => Promise<void>; loadOlderAudit: () => Promise<void> }) {
  const [showAddUser, setShowAddUser] = useState(false)

  return <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <section className="rounded-xl border border-[#c3c6d7] bg-white lg:col-span-2">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h3 className="text-lg font-semibold leading-[1.4] text-[#191b23]">用户管理</h3>
          <button onClick={() => setShowAddUser(true)} className={primaryButton}>+ 添加用户</button>
        </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] border-collapse text-left text-sm">
          <thead><tr className="border-b border-[#c3c6d7] text-xs font-normal uppercase leading-none tracking-wider text-[#434655]"><th className="px-2 py-2 font-normal">用户</th><th className="px-2 py-2 font-normal">状态</th><th className="px-2 py-2 font-normal">生成中</th><th className="px-2 py-2 font-normal">额度</th><th className="px-2 py-2 font-normal">模式</th><th className="px-2 py-2 font-normal">操作</th></tr></thead>
          <tbody className="text-sm leading-[1.5] text-[#191b23]">
            {usersLoading && <tr><td colSpan={6} className="px-2 py-8 text-center text-[#434655]">正在加载用户列表…</td></tr>}
            {!usersLoading && usersError && <tr><td colSpan={6} className="px-2 py-8 text-center text-[#ba1a1a]">用户列表加载失败：{usersError}</td></tr>}
            {!usersLoading && !usersError && users.length === 0 && <tr><td colSpan={6} className="px-2 py-8 text-center text-[#434655]">暂无用户。使用上方表单添加用户，或让用户在登录页注册。</td></tr>}
            {!usersLoading && !usersError && users.map((u) => <tr key={u.id} className={`border-b border-[#e1e2ed] transition-colors hover:bg-[#faf8ff] ${u.banned ? 'bg-[#ffdad6]/20' : ''}`}><td className="px-2 py-4"><div className="flex items-center gap-2"><Avatar name={u.username} muted={u.banned} /><div><div className={`text-sm font-medium leading-none ${u.banned ? 'text-[#ba1a1a]' : 'text-[#191b23]'}`}>{u.username || '未命名用户'}</div><div className="mt-1 text-xs text-[#434655]">ID: {u.id.slice(0, 4)}</div></div></div></td><td className="px-2 py-4"><StatusPill user={u} /></td><td className="px-2 py-4">{u.runningTasks}</td><td className="px-2 py-4"><input type="number" defaultValue={u.quotaTotal} onBlur={(e) => { const next = Number(e.target.value); if (next !== u.quotaTotal) void patchUser(u.id, { quotaTotal: next }) }} className="w-16 border-0 border-b border-[#c3c6d7] bg-transparent px-1 py-0.5 text-center text-sm focus:border-[#191b23] focus:ring-0" /></td><td className="px-2 py-4"><ModeSwitch user={u} patchUser={patchUser} /></td><td className="px-2 py-4"><button onClick={() => patchUser(u.id, { banned: !u.banned })} className="text-xs font-medium text-[#ba1a1a] hover:opacity-80">{u.banned ? '解封' : '封禁'}</button></td></tr>)}
          </tbody>
        </table>
      </div>
      </div>
    </section>
    <AuditLog audit={audit} failures={failures} loading={auditLoading} hasMore={auditHasMore} loadMore={loadOlderAudit} />
    {showAddUser && <AddUserModal onClose={() => setShowAddUser(false)} onCreated={async (user) => { if (user) setUsers((current) => [user, ...current.filter((item) => item.id !== user.id)]); else await reload(); void refreshAudit().catch(() => undefined) }} />}
  </div>
}

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (user?: AdminUser) => Promise<void> | void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setNotice(null)
    if (!username.trim() || !password) {
      setNotice({ type: 'error', text: '请填写用户名和密码' })
      return
    }
    setSaving(true)
    try {
      const result = await apiRequest<{ user?: AdminUser }>('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: username.trim(), password, quotaTotal: 0 }) })
      setNotice({ type: 'success', text: '用户已创建' })
      await onCreated(result.user)
      window.setTimeout(onClose, 450)
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm" onMouseDown={onClose}>
    <form onSubmit={submit} onMouseDown={(e) => e.stopPropagation()} className="flex w-full max-w-[480px] flex-col overflow-hidden rounded-xl border border-[#c3c6d7] bg-white shadow-[0_4px_24px_rgba(0,0,0,0.04)]">
      <div className="border-b border-[#c3c6d7]/30 p-6 pb-4">
        <h3 className="mb-2 text-2xl font-semibold leading-[1.3] tracking-[-0.01em] text-[#191b23]">添加用户</h3>
        <p className="text-sm leading-[1.5] text-[#434655]">创建一个默认额度为 0 的分发用户。稍后可在用户表格中调整额度和模式。</p>
      </div>
      <div className="space-y-4 p-6">
        {notice && <ModalNotice type={notice.type}>{notice.text}</ModalNotice>}
        <label className="flex flex-col gap-2"><span className="text-xs font-bold uppercase leading-none tracking-wider text-[#191b23]">用户名</span><input autoFocus placeholder="例如：metropolitan_admin" value={username} onChange={(e) => setUsername(e.target.value)} className="h-10 w-full rounded-lg border border-[#c3c6d7] bg-[#f3f3fe] px-3 text-sm leading-[1.5] text-[#191b23] outline-none placeholder:text-[#737686] focus:border-[#191b23] focus:ring-0" /></label>
        <label className="flex flex-col gap-2"><span className="text-xs font-bold uppercase leading-none tracking-wider text-[#191b23]">密码</span><input placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="h-10 w-full rounded-lg border border-[#c3c6d7] bg-[#f3f3fe] px-3 text-sm leading-[1.5] text-[#191b23] outline-none placeholder:text-[#737686] focus:border-[#191b23] focus:ring-0" /></label>
      </div>
      <div className="flex justify-end gap-3 border-t border-[#c3c6d7]/30 bg-[#faf8ff] p-6 pt-4">
        <button type="button" onClick={onClose} className="rounded-lg border border-[#c3c6d7] bg-white px-6 py-2 text-sm font-medium leading-none text-[#191b23] transition-colors hover:bg-[#f3f3fe]">取消</button>
        <button disabled={saving} className="rounded-lg bg-[#191b23] px-6 py-2 text-sm font-medium leading-none text-white transition-colors hover:bg-[#191b23]/90 disabled:opacity-60">{saving ? '创建中…' : '创建用户'}</button>
      </div>
    </form>
  </div>
}

function ModalNotice({ type, children }: { type: 'success' | 'error'; children: ReactNode }) {
  const isError = type === 'error'
  return <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${isError ? 'border-[#ba1a1a]/20 bg-[#ffdad6] text-[#93000a]' : 'border-[#c3c6d7]/50 bg-[#ededf9] text-[#191b23]'}`}>
    <MaterialLikeIcon name={isError ? 'error' : 'check_circle'} className={`mt-0.5 text-[20px] ${isError ? '' : 'text-[#004ac6]'}`} />
    <p className="text-sm font-medium leading-[1.5]">{children}</p>
  </div>
}

function InlineNotice({ type, children }: { type: 'success' | 'error'; children: ReactNode }) {
  const tone = type === 'success' ? 'text-[#5f5e61]' : type === 'error' ? 'text-red-700' : 'text-[#5f5e61]'
  const icon = type === 'error' ? '!' : '✓'
  return <div className={`mt-2 flex items-center gap-1 text-sm leading-[1.5] ${tone}`}><span className="text-base leading-none">{icon}</span><span>{children}</span></div>
}

function Avatar({ name, muted }: { name: string; muted?: boolean }) {
  const initials = name.trim().slice(0, 2).toUpperCase() || 'U'
  return <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#e1e2ed] text-xs font-medium text-[#434655] ${muted ? 'opacity-50 grayscale' : ''}`}>{initials}</div>
}

function StatusPill({ user }: { user: AdminUser }) {
  if (user.banned) return <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700">已封禁</span>
  if (user.runningTasks > 0) return <span className="inline-flex items-center rounded-full border border-[#b4c5ff] bg-[#dbe1ff] px-2 py-1 text-xs font-medium text-[#00174b]"><span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-[#004ac6]" />生成中</span>
  if (user.online) return <span className="inline-flex items-center rounded-full border border-[#c3c6d7] bg-[#ededf9] px-2 py-1 text-xs font-medium text-[#191b23]"><span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-green-500" />在线</span>
  return <span className="inline-flex items-center rounded-full border border-[#c3c6d7] bg-[#ededf9] px-2 py-1 text-xs font-medium text-[#434655]">离线</span>
}

function ModeSwitch({ user, patchUser }: { user: AdminUser; patchUser: (id: string, patch: Partial<AdminUser>) => Promise<void> }) {
  return <div className="flex w-fit rounded border border-[#c3c6d7] bg-[#f3f3fe] p-0.5">
    <button onClick={() => patchUser(user.id, { allowDirect: !user.allowDirect })} className={`rounded px-2 py-1 text-xs font-medium ${user.allowDirect ? 'bg-white text-[#191b23] shadow-sm' : 'text-[#434655]'}`}>直传</button>
    <button onClick={() => patchUser(user.id, { allowBucket: !user.allowBucket })} className={`rounded px-2 py-1 text-xs font-medium ${user.allowBucket ? 'bg-white text-[#191b23] shadow-sm' : 'text-[#434655]'}`}>存储桶</button>
  </div>
}

function AuditLog({ audit, failures, loading, hasMore, loadMore }: { audit: AuditEntry[]; failures: Failure[]; loading: boolean; hasMore: boolean; loadMore: () => Promise<void> }) {
  const entries = audit
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    if (!hasMore || loading) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
      void loadMore()
    }
  }
  return <aside className="flex flex-col rounded-xl border border-[#c3c6d7] bg-white">
    <div className="border-b border-[#c3c6d7] p-6"><h3 className="text-lg font-semibold leading-[1.4] text-[#191b23]">系统审计日志</h3></div>
    <div onScroll={handleScroll} className="max-h-[520px] flex-1 space-y-4 overflow-y-auto p-4 pr-3">
      {entries.length === 0 && failures.length === 0 && <AuditItem icon="✓" title="暂无活动" detail="系统操作记录会显示在这里。" time="现在" />}
      {entries.map((item) => <AuditItem key={item.id} icon={auditIcon(item.type)} title={item.title} detail={item.detail} time={new Date(item.createdAt).toLocaleString()} danger={item.type.includes('fail')} />)}
      {entries.length === 0 && failures.slice(0, 3).map((f) => <AuditItem key={f.id} icon="!" title="生图失败" detail={`${f.username}: ${f.prompt || f.error}`} time={new Date(f.createdAt).toLocaleString()} danger />)}
      {loading && <div className="rounded-lg bg-[#faf8ff] px-3 py-2 text-center text-xs text-[#434655]">正在加载日志…</div>}
      {!loading && hasMore && <button onClick={() => void loadMore()} className="w-full rounded-lg border border-[#c3c6d7] bg-[#faf8ff] px-3 py-2 text-xs font-medium text-[#434655] hover:bg-[#f3f3fe]">加载更旧日志</button>}
      {!loading && !hasMore && entries.length > 0 && <div className="px-3 py-2 text-center text-xs text-[#737686]">已显示全部日志</div>}
    </div>
    <div className="rounded-b-xl border-t border-[#c3c6d7] bg-[#faf8ff] p-4 text-center text-[11px] font-bold uppercase tracking-wider text-[#191b23] dark:border-white/[0.08] dark:bg-white/[0.03]">查看详细审计日志</div>
  </aside>
}

function auditIcon(type: string) {
  if (type.includes('login')) return 'login'
  if (type.includes('generation')) return 'image'
  if (type.includes('user')) return 'person'
  if (type.includes('bucket')) return 'storage'
  return 'info'
}

function AuditItem({ icon, title, detail, time, danger }: { icon: string; title: string; detail: string; time: string; danger?: boolean }) {
  return <div className="flex items-start gap-4"><div className={`mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full ${danger ? 'bg-[#ffdad6] text-[#ba1a1a]' : 'bg-[#dbe1ff] text-[#004ac6]'}`}>{icon}</div><div><div className="text-sm font-medium leading-none text-[#191b23]">{title}</div><div className="mt-1 line-clamp-2 text-sm leading-[1.5] text-[#434655]">{detail}</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#5f5e61]">{time}</div></div></div>
}

function UpdatesTab({ setGlobalMessage }: { setGlobalMessage: (msg: string) => void }) {
  const [info, setInfo] = useState<UpdateCheck | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    try { setInfo(await apiRequest<UpdateCheck>('/api/admin/update/check')); setMessage('检查完成') } finally { setBusy(false) }
  }
  const update = async (part: 'backend' | 'frontend') => {
    setBusy(true)
    try { const result = await apiRequest<{ message: string }>(`/api/admin/update/${part}`, { method: 'POST' }); setMessage(result.message); setGlobalMessage(result.message); await check() } finally { setBusy(false) }
  }
  const restart = async () => {
    setBusy(true)
    try { await apiRequest('/api/admin/update/restart', { method: 'POST' }); setMessage('服务正在重启，请稍后刷新页面') } finally { setBusy(false) }
  }
  useEffect(() => { void check() }, [])
  const row = (label: string, data: UpdateInfo | undefined, part: 'backend' | 'frontend') => <div className="rounded-xl border border-[#c3c6d7] bg-white p-6"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><div className="font-semibold">{label}</div><div className="mt-1 text-sm text-[#434655]">当前 {data?.currentVersion || '-'} · 最新 {data?.latestVersion || '-'}</div>{data?.assetName && <div className="mt-2 font-mono text-xs text-[#434655]">{data.assetName}</div>}</div><button disabled={busy || !data?.updateAvailable} onClick={() => update(part)} className={primaryButton}>{data?.updateAvailable ? '更新' : '已是最新'}</button></div></div>
  return <div className="grid gap-6 lg:grid-cols-[1fr_320px]"><div className="space-y-4">{row('后端二进制', info?.backend, 'backend')}{row('前端静态资源', info?.frontend, 'frontend')}</div><aside className="rounded-xl border border-[#c3c6d7] bg-white p-6"><div className="font-semibold">Release 控制台</div><p className="mt-2 text-sm leading-6 text-[#434655]">检查 GitHub Release 中的前后端独立版本，并按需更新。</p><div className="mt-5 grid gap-2"><button disabled={busy} onClick={check} className={quietButton}>检查更新</button><button disabled={busy} onClick={restart} className="h-[36px] rounded bg-red-600 px-4 text-sm font-medium text-white disabled:bg-zinc-300">重启后端</button></div>{message && <div className="mt-4 rounded-lg bg-[#f3f3fe] px-3 py-2 text-sm text-[#434655]">{message}</div>}</aside></div>
}

function StorageTab({ buckets, addBucket }: { buckets: Bucket[]; addBucket: (e: React.FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <div className="grid gap-6 lg:grid-cols-[420px_minmax(0,1fr)]"><form onSubmit={addBucket} className="rounded-xl border border-[#c3c6d7] bg-white p-6"><h3 className="text-lg font-semibold">连接 COS 存储桶</h3><p className="mt-2 text-sm leading-6 text-[#434655]">配置后可为用户启用存储桶模式，降低直传带宽压力。</p><div className="mt-5 grid gap-3"><input name="name" placeholder="名称" className={inputClass} /><input name="bucketUrl" placeholder="Bucket URL，例如 https://xxx.cos.ap-guangzhou.myqcloud.com" className={inputClass} /><input name="secretId" placeholder="SecretId" className={inputClass} /><input name="secretKey" placeholder="SecretKey" type="password" className={inputClass} /><input name="pathPrefix" placeholder="路径前缀 images" className={inputClass} /><input name="tempUrlMinutes" placeholder="临时链接分钟数" type="number" className={inputClass} /><button className={`${primaryButton} mt-2`}>添加存储桶</button></div></form><section className="rounded-xl border border-[#c3c6d7] bg-white p-6"><div className="flex items-center justify-between"><h3 className="text-lg font-semibold">存储资产</h3><span className="text-xs text-[#434655]">{buckets.length} 个桶</span></div><div className="mt-5 grid gap-3 md:grid-cols-2">{buckets.length === 0 && <div className="rounded-lg bg-[#faf8ff] p-4 text-sm text-[#434655]">暂无存储桶</div>}{buckets.map((b) => <div key={b.id} className="rounded-lg border border-[#c3c6d7] bg-[#faf8ff] p-4"><div className="flex items-center justify-between gap-3"><div className="font-medium">{b.name}</div><div className="rounded-full bg-[#ededf9] px-2 py-1 text-xs text-[#434655]">{b.imageCount} 张</div></div><div className="mt-3 break-all font-mono text-xs leading-5 text-[#434655]">{b.bucketUrl}</div><div className="mt-3 text-xs text-[#434655]">前缀 {b.pathPrefix || '-'} · 临时链接 {b.tempUrlMinutes} 分钟</div></div>)}</div></section></div>
}
