import type { AppSettings, CurrentUser, TaskParams } from '../types'
import type { CallApiResult } from './api'

export interface BackendGenerateOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

export interface BackendTaskImage {
  dataUrl?: string
  url?: string
  objectKey?: string
}

export interface BackendTask {
  id: string
  prompt: string
  params: TaskParams
  mode: 'direct' | 'bucket'
  status: 'running' | 'done' | 'error'
  error?: string
  images?: BackendTaskImage[]
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  revisedPrompts?: Array<string | undefined>
  createdAt: number
  finishedAt?: number
  elapsed?: number
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json()
    if (typeof payload.error === 'string') return payload.error
  } catch {
    // ignore
  }
  return `HTTP ${response.status}`
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.json() as Promise<T>
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const payload = await apiRequest<{ user: CurrentUser | null }>('/api/auth/me')
  return payload.user
}

export async function loginUser(username: string, password: string): Promise<CurrentUser> {
  const payload = await apiRequest<{ user: CurrentUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, role: 'user' }),
  })
  return payload.user
}

export async function loginAdmin(adminKey: string): Promise<CurrentUser> {
  const payload = await apiRequest<{ user: CurrentUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ adminKey, role: 'admin' }),
  })
  return payload.user
}

export async function registerUser(username: string, password: string): Promise<CurrentUser> {
  const payload = await apiRequest<{ user: CurrentUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  return payload.user
}

export async function logout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST' })
}

export async function submitBackendTask(opts: BackendGenerateOptions): Promise<BackendTask> {
  return apiRequest<BackendTask>('/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      prompt: opts.prompt,
      params: opts.params,
      inputImageDataUrls: opts.inputImageDataUrls,
      maskDataUrl: opts.maskDataUrl,
      mode: opts.settings.deliveryMode,
    }),
  })
}

export async function fetchBackendTask(id: string): Promise<BackendTask> {
  return apiRequest<BackendTask>(`/api/tasks/${encodeURIComponent(id)}`)
}

export function backendTaskToResult(task: BackendTask): CallApiResult {
  const images = (task.images ?? []).map((image) => image.dataUrl || image.url || '').filter(Boolean)
  return {
    images,
    actualParams: task.actualParams,
    actualParamsList: task.actualParamsList,
    revisedPrompts: task.revisedPrompts,
  }
}
