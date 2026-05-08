import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  ExportData,
  CurrentUser,
} from './types'
import { DEFAULT_SETTINGS, DEFAULT_PARAMS } from './types'
import {
  getAllTasks,
  putTask,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  getImage,
  getAllImages,
  putImage,
  deleteImage,
  clearImages,
  storeImage,
  hashDataUrl,
} from './lib/db'
import { backendTaskImageUrl, backendTaskToResult, fetchBackendImage, fetchBackendTask, fetchBackendTasks, getCurrentUser, hideBackendTasks, submitBackendTask } from './lib/backend'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { normalizeImageSize } from './lib/size'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

// ===== Image cache =====
// 内存缓存，id → dataUrl，避免每次从 IndexedDB 读取

const imageCache = new Map<string, string>()
let taskHydrationVersion = 0

function nextTaskHydrationVersion(): number {
  taskHydrationVersion += 1
  return taskHydrationVersion
}

function isCurrentHydrationTarget(user: CurrentUser | null, version: number): boolean {
  const currentUser = useStore.getState().currentUser
  return taskHydrationVersion === version
    && (currentUser?.id ?? null) === (user?.id ?? null)
    && (currentUser?.role ?? null) === (user?.role ?? null)
}

export function getCachedImage(id: string): string | undefined {
  return imageCache.get(id)
}

async function cacheRemoteImage(id: string, sourceUrl: string): Promise<string | undefined> {
  try {
    const response = await fetchBackendImage(sourceUrl, { cache: 'force-cache' })
    const blob = await response.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    if (!dataUrl) return undefined
    await putImage({ id, dataUrl, createdAt: Date.now(), source: 'generated' })
    imageCache.set(id, dataUrl)
    return dataUrl
  } catch {
    return undefined
  }
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  if (imageCache.has(id)) return imageCache.get(id)
  const task = useStore.getState().tasks.find((t) => t.outputImageUrls?.[id])
  const url = task?.outputImageUrls?.[id]
  const rec = await getImage(id)
  if (rec) {
    imageCache.set(id, rec.dataUrl)
    return rec.dataUrl
  }

  if (url) {
    const cached = await cacheRemoteImage(id, url)
    if (cached) return cached
    imageCache.set(id, url)
    return url
  }

  const imageUrl = backendTaskImageUrl(id)
  const cached = await cacheRemoteImage(id, imageUrl)
  if (cached) return cached
  imageCache.set(id, imageUrl)
  return imageUrl
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

function isTaskVisibleToUser(task: TaskRecord, user: CurrentUser | null): boolean {
  return Boolean(user && task.ownerUserId === user.id)
}

function getHiddenTaskIdsForUser(user: CurrentUser | null): Set<string> {
  if (!user) return new Set()
  return new Set(useStore.getState().hiddenTaskIdsByUser[user.id] ?? [])
}

function syncTaskIntoVisibleStore(task: TaskRecord, replacedTaskId?: string) {
  useStore.setState((state) => {
    const nextTasks = state.tasks.filter(
      (item) =>
        item.id !== task.id &&
        item.backendTaskId !== task.backendTaskId &&
        item.id !== replacedTaskId,
    )
    nextTasks.push(task)
    nextTasks.sort((a, b) => b.createdAt - a.createdAt)
    return { tasks: nextTasks }
  })
}

async function hydrateTasksForCurrentUser(currentUser: CurrentUser | null, version: number) {
  await loadLocalTasksForUser(currentUser, version)
  if (!currentUser || !isCurrentHydrationTarget(currentUser, version)) return
  void resumeRunningTasks()
  void syncBackendTasksToLocal(currentUser, version)
    .then(() => loadLocalTasksForUser(currentUser, version))
    .catch(() => undefined)
}

async function loadLocalTasksForUser(user: CurrentUser | null, version?: number): Promise<void> {
  const tasks = await getAllTasks()
  if (version != null && !isCurrentHydrationTarget(user, version)) return
  const hiddenTaskIds = getHiddenTaskIdsForUser(user)
  const visibleTasks = tasks.filter((task) => isTaskVisibleToUser(task, user) && !hiddenTaskIds.has(task.backendTaskId ?? task.id))
  useStore.getState().setTasks(visibleTasks)

  // 收集全部本地任务引用的图片 id，避免切换账号时误删其他用户的本地图片缓存。
  const referencedIds = new Set<string>()
  for (const t of tasks) {
    for (const id of t.inputImageIds || []) referencedIds.add(id)
    if (t.maskImageId) referencedIds.add(t.maskImageId)
    for (const id of t.outputImages || []) referencedIds.add(id)
  }

  const visibleImageIds = new Set<string>()
  for (const t of visibleTasks) {
    for (const id of t.inputImageIds || []) visibleImageIds.add(id)
    if (t.maskImageId) visibleImageIds.add(t.maskImageId)
    for (const id of t.outputImages || []) visibleImageIds.add(id)
  }

  const images = await getAllImages()
  if (version != null && !isCurrentHydrationTarget(user, version)) return
  imageCache.clear()
  for (const img of images) {
    if (visibleImageIds.has(img.id)) {
      imageCache.set(img.id, img.dataUrl)
    } else if (!referencedIds.has(img.id)) {
      await deleteImage(img.id)
    }
  }
}

function mergeTaskRecord(task: TaskRecord) {
  const tasks = useStore.getState().tasks
  const match = tasks.find((item) => item.id === task.id || (task.backendTaskId && item.backendTaskId === task.backendTaskId))
  if (!match) return { task }

  return {
    task: {
      ...match,
      ...task,
      isFavorite: task.isFavorite ?? match.isFavorite,
    },
    replacedTaskId: match.id !== task.id ? match.id : undefined,
  }
}

async function syncBackendTasksToLocal(user: CurrentUser, version?: number): Promise<void> {
  const backendTasks = await fetchBackendTasks()
  if (version != null && !isCurrentHydrationTarget(user, version)) return
  const hiddenTaskIds = getHiddenTaskIdsForUser(user)

  for (const backendTask of backendTasks) {
    if (version != null && !isCurrentHydrationTarget(user, version)) return
    if (hiddenTaskIds.has(backendTask.id)) {
      continue
    }

    const result = backendTaskToResult(backendTask)
    const outputImages: string[] = []

    for (const imageId of result.images) {
      outputImages.push(imageId)
    }

    const actualParamsByImage = result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
      const imgId = outputImages[index]
      if (imgId && params && Object.keys(params).length > 0) acc[imgId] = params
      return acc
    }, {})
    const revisedPromptByImage = result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
      const imgId = outputImages[index]
      if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
      return acc
    }, {})

    const merged = mergeTaskRecord({
      id: backendTask.id,
      ownerUserId: user.id,
      prompt: backendTask.prompt,
      params: backendTask.params,
      actualParams: result.actualParams,
      actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length > 0 ? actualParamsByImage : undefined,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      inputImageIds: [],
      outputImages,
      outputImageUrls: {},
      backendTaskId: backendTask.id,
      deliveryMode: backendTask.mode,
      status: backendTask.status,
      error: backendTask.error ?? null,
      createdAt: backendTask.createdAt,
      finishedAt: backendTask.finishedAt ?? null,
      elapsed: backendTask.elapsed ?? null,
    })
    await putTask(merged.task)
    if (merged.replacedTaskId) {
      await dbDeleteTask(merged.replacedTaskId)
    }
    if (version != null && !isCurrentHydrationTarget(user, version)) return
    syncTaskIntoVisibleStore(merged.task, merged.replacedTaskId)
  }
}

async function pollBackendTaskUntilSettled(taskId: string): Promise<void> {
  let latestBackendTask = await fetchBackendTask(taskId)
  while (latestBackendTask.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    latestBackendTask = await fetchBackendTask(taskId)
  }

  const result = backendTaskToResult(latestBackendTask)
  const outputIds: string[] = []
  for (const imageId of result.images) {
    outputIds.push(imageId)
  }

  const actualParamsByImage = result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
    const imgId = outputIds[index]
    if (imgId && params && Object.keys(params).length > 0) acc[imgId] = params
    return acc
  }, {})
  const revisedPromptByImage = result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
    const imgId = outputIds[index]
    if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
    return acc
  }, {})

  updateTaskInStore(taskId, {
    outputImages: outputIds,
    outputImageUrls: {},
    actualParams: { ...result.actualParams, n: outputIds.length },
    actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length > 0 ? actualParamsByImage : undefined,
    revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
    status: latestBackendTask.status,
    error: latestBackendTask.error ?? null,
    finishedAt: latestBackendTask.finishedAt ?? null,
    elapsed: latestBackendTask.elapsed ?? null,
  })
}

async function resumeRunningTasks(): Promise<void> {
  const runningTasks = useStore.getState().tasks.filter((task) => task.status === 'running' && task.backendTaskId)
  await Promise.allSettled(runningTasks.map((task) => pollBackendTaskUntilSettled(task.backendTaskId!)))
}

// ===== Store 类型 =====

interface AppState {
  currentUser: CurrentUser | null
  setCurrentUser: (user: CurrentUser | null) => void
  authChecked: boolean
  setAuthChecked: (checked: boolean) => void
  hiddenTaskIdsByUser: Record<string, string[]>
  hideTasksForCurrentUser: (ids: string[]) => void
  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[]) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    showCancel?: boolean
    icon?: 'info'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Settings
      currentUser: null,
      setCurrentUser: (currentUser) => {
        const hydrationVersion = nextTaskHydrationVersion()
        set({ currentUser, tasks: [], selectedTaskIds: [], detailTaskId: null, lightboxImageId: null, lightboxImageList: [] })
        void hydrateTasksForCurrentUser(currentUser, hydrationVersion)
      },
      authChecked: false,
      setAuthChecked: (authChecked) => set({ authChecked }),
      hiddenTaskIdsByUser: {},
      hideTasksForCurrentUser: (ids) => set((s) => {
        const userId = s.currentUser?.id
        if (!userId || ids.length === 0) return s
        const next = new Set(s.hiddenTaskIdsByUser[userId] ?? [])
        let changed = false
        for (const id of ids) {
          if (!id || next.has(id)) continue
          next.add(id)
          changed = true
        }
        if (!changed) return s
        return {
          hiddenTaskIdsByUser: {
            ...s.hiddenTaskIdsByUser,
            [userId]: Array.from(next),
          },
        }
      }),
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => ({
        settings: {
          ...st.settings,
          ...s,
          apiMode:
            s.apiMode === 'images' || s.apiMode === 'responses'
              ? s.apiMode
              : st.settings.apiMode ?? DEFAULT_SETTINGS.apiMode,
          codexCli: s.codexCli ?? st.settings.codexCli ?? DEFAULT_SETTINGS.codexCli,
          apiProxy: s.apiProxy ?? st.settings.apiProxy ?? DEFAULT_SETTINGS.apiProxy,
        },
      })),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages: s.inputImages.filter((_, i) => i !== idx),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return { inputImages: [], maskDraft: null, maskEditorImageId: null }
        }),
      setInputImages: (imgs) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          const shouldClearMask =
            Boolean(s.maskDraft) && !inputImages.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages,
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return { inputImages: images }
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => ({
          maskDraft,
          inputImages: orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId),
        })),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => set({ maskEditorImageId }),

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set({ tasks }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => set({ detailTaskId }),
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) =>
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) }),
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => set({ confirmDialog }),
    }),
    {
      name: 'gpt-image-playground',
      partialize: (state) => ({
        settings: state.settings,
        params: state.params,
        dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
        hiddenTaskIdsByUser: state.hiddenTaskIdsByUser,
      }),
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  return `${settings.baseUrl}\n${settings.apiKey}`
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function normalizeParamsForSettings(params: TaskParams, settings: AppSettings): TaskParams {
  return {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    quality: settings.codexCli ? DEFAULT_PARAMS.quality : params.quality,
  }
}

/** 初始化：从 IndexedDB 加载任务和图片缓存，清理孤立图片 */
export async function initStore() {
  const hydrationVersion = nextTaskHydrationVersion()
  let currentUser: CurrentUser | null = null
  try {
    currentUser = await getCurrentUser()
    useStore.setState({ currentUser })
  } catch {
    currentUser = null
    useStore.setState({ currentUser: null })
  }

  await loadLocalTasksForUser(currentUser, hydrationVersion)
  useStore.getState().setAuthChecked(true)

  if (currentUser && isCurrentHydrationTarget(currentUser, hydrationVersion)) {
    void resumeRunningTasks()
    void syncBackendTasksToLocal(currentUser, hydrationVersion)
      .then(() => loadLocalTasksForUser(currentUser, hydrationVersion))
      .catch(() => undefined)
  }
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, showToast, setConfirmDialog } =
    useStore.getState()

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      imageCache.set(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  const { currentUser } = useStore.getState()
  if (!currentUser) {
    showToast('请先登录', 'error')
    return
  }

  if (settings.deliveryMode === 'direct' && currentUser.allowDirect === false) {
    showToast('管理员未为你开启直传模式', 'error')
    return
  }

  if (settings.deliveryMode === 'bucket' && currentUser.allowBucket === false) {
    showToast('管理员未为你开启存储桶模式', 'error')
    return
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = normalizeParamsForSettings(params, settings)
  if (normalizedParams.size !== params.size || normalizedParams.quality !== params.quality) {
    useStore.getState().setParams({ size: normalizedParams.size, quality: normalizedParams.quality })
  }

  const taskId = genId()
  const task: TaskRecord = {
    id: taskId,
    ownerUserId: currentUser.id,
    prompt: prompt.trim(),
    params: normalizedParams,
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    outputImages: [],
    outputImageUrls: {},
    deliveryMode: settings.deliveryMode,
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  let backendTask
  try {
    backendTask = await submitBackendTask({
      settings,
      prompt: task.prompt,
      params: task.params,
      inputImageDataUrls: orderedInputImages.map((img) => img.dataUrl),
      maskDataUrl: maskDraft?.maskDataUrl,
    })
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return
  }

  const persistedTask: TaskRecord = {
    ...task,
    id: backendTask.id,
    backendTaskId: backendTask.id,
    status: backendTask.status,
    createdAt: backendTask.createdAt,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([persistedTask, ...latestTasks])
  await putTask(persistedTask)

  // 异步轮询后端任务
  void executeTask(backendTask.id)
}

async function executeTask(taskId: string) {
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return

  try {
    const latestBackendTask = await fetchBackendTask(task.backendTaskId ?? task.id)

    if (latestBackendTask.status === 'running') {
      await pollBackendTaskUntilSettled(latestBackendTask.id)
      return
    }

    if (latestBackendTask.status === 'error') {
      throw new Error(latestBackendTask.error || '生成失败')
    }

    const result = backendTaskToResult(latestBackendTask)

    // 更新输出图片 id，并通过独立接口按需加载图像数据
    const outputIds: string[] = []
    for (const imageId of result.images) {
      outputIds.push(imageId)
    }
    const actualParamsByImage = result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
      const imgId = outputIds[index]
      if (imgId && params && Object.keys(params).length > 0) acc[imgId] = params
      return acc
    }, {})
    const revisedPromptByImage = result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
      const imgId = outputIds[index]
      if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
      return acc
    }, {})
    const promptWasRevised = result.revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== task.prompt.trim(),
    )
    const hasRevisedPromptValue = result.revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    const settings = useStore.getState().settings
    if (!settings.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      outputImageUrls: {},
      actualParams: { ...result.actualParams, n: outputIds.length },
      actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length > 0 ? actualParamsByImage : undefined,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      status: 'done',
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })

    useStore.getState().showToast(`生成完成，共 ${outputIds.length} 张图片`, 'success')
  } catch (err) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    useStore.getState().setDetailTaskId(taskId)
  }

  // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
  for (const imgId of task.inputImageIds) {
    imageCache.delete(imgId)
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  const { settings, currentUser, showToast } = useStore.getState()
  if (!currentUser || currentUser.role !== 'user') return
  try {
    const normalizedParams = normalizeParamsForSettings(task.params, settings)
    const deliveryMode = task.deliveryMode ?? settings.deliveryMode ?? DEFAULT_SETTINGS.deliveryMode
    const inputImageDataUrls: string[] = []
    for (const inputImageId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(inputImageId)
      if (!dataUrl?.startsWith('data:image/')) throw new Error('缺少原始输入图片，无法重试，请先重新上传原图')
      inputImageDataUrls.push(dataUrl)
    }
    const maskDataUrl = task.maskImageId ? await ensureImageCached(task.maskImageId) : undefined
    if (maskDataUrl && !maskDataUrl.startsWith('data:image/')) {
      throw new Error('缺少遮罩图片，无法重试，请先重新上传原图后再编辑')
    }

    const backendTask = await submitBackendTask({
      settings: { ...settings, deliveryMode },
      prompt: task.prompt,
      params: normalizedParams,
      inputImageDataUrls,
      maskDataUrl,
    })

    const newTask: TaskRecord = {
      id: backendTask.id,
      ownerUserId: currentUser.id,
      prompt: task.prompt,
      params: normalizedParams,
      inputImageIds: [...task.inputImageIds],
      maskTargetImageId: task.maskTargetImageId ?? null,
      maskImageId: task.maskImageId ?? null,
      outputImages: [],
      outputImageUrls: {},
      backendTaskId: backendTask.id,
      deliveryMode,
      status: 'running',
      error: null,
      createdAt: backendTask.createdAt,
      finishedAt: null,
      elapsed: null,
    }

    const latestTasks = useStore.getState().tasks
    useStore.getState().setTasks([newTask, ...latestTasks])
    await putTask(newTask)

    void executeTask(backendTask.id)
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast } = useStore.getState()
  setPrompt(task.prompt)
  setParams(task.params)

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  showToast('已复用配置到输入框', 'success')
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, selectedTaskIds, hideTasksForCurrentUser } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const backendTaskIds = Array.from(new Set(tasks.filter((t) => toDelete.has(t.id)).map((t) => t.backendTaskId).filter((id): id is string => Boolean(id))))
  const hiddenTaskIds = tasks.filter((t) => toDelete.has(t.id)).map((t) => t.backendTaskId ?? t.id)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  if (backendTaskIds.length > 0) {
    try {
      await hideBackendTasks(backendTaskIds)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
    }
  }

  hideTasksForCurrentUser(hiddenTaskIds)
  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  // 如果删除的任务在选中列表中，则移除
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast, hideTasksForCurrentUser } = useStore.getState()

  if (task.backendTaskId) {
    try {
      await hideBackendTasks([task.backendTaskId])
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
  ])

  // 从列表移除
  const remaining = tasks.filter((t) => t.id !== task.id)
  hideTasksForCurrentUser([task.backendTaskId ?? task.id])
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  showToast('记录已删除', 'success')
}

/** 清空所有数据（含配置重置） */
export async function clearAllData() {
  await dbClearTasks()
  await clearImages()
  imageCache.clear()
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  setTasks([])
  clearInputImages()
  useStore.setState({ dismissedCodexCliPrompts: [], hiddenTaskIdsByUser: {} })
  clearMaskDraft()
  setSettings({ ...DEFAULT_SETTINGS })
  setParams({ ...DEFAULT_PARAMS })
  showToast('所有数据已清空', 'success')
}

/** 从 dataUrl 解析出 MIME 扩展名和二进制数据 */
function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,/)
  const ext = match?.[1] ?? 'png'
  const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}

/** 将二进制数据还原为 dataUrl */
function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
  const mime = mimeMap[ext] ?? 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

/** 导出数据为 ZIP */
export async function exportData() {
  try {
    const { settings, currentUser } = useStore.getState()
    const tasks = (await getAllTasks()).filter((task) => isTaskVisibleToUser(task, currentUser))
    const images = await getAllImages()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()

    for (const task of tasks) {
      for (const id of [
        ...(task.inputImageIds || []),
        ...(task.maskImageId ? [task.maskImageId] : []),
        ...(task.outputImages || []),
      ]) {
        const prev = imageCreatedAtFallback.get(id)
        if (prev == null || task.createdAt < prev) {
          imageCreatedAtFallback.set(id, task.createdAt)
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    for (const img of images.filter((image) => imageCreatedAtFallback.has(image.id))) {
      const { ext, bytes } = dataUrlToBytes(img.dataUrl)
      const path = `images/${img.id}.${ext}`
      const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
      imageFiles[img.id] = { path, createdAt, source: img.source }
      zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]
    }

    const manifest: ExportData = {
      version: 2,
      exportedAt: new Date(exportedAt).toISOString(),
      settings,
      tasks,
      imageFiles,
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-${Date.now()}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

/** 导入 ZIP 数据 */
export async function importData(file: File) {
  try {
    const { currentUser } = useStore.getState()
    if (!currentUser || currentUser.role !== 'user') throw new Error('请先登录普通用户账号')
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))
    if (!data.tasks || !data.imageFiles) throw new Error('无效的数据格式')

    // 还原图片
    for (const [id, info] of Object.entries(data.imageFiles)) {
      const bytes = unzipped[info.path]
      if (!bytes) continue
      const dataUrl = bytesToDataUrl(bytes, info.path)
      await putImage({ id, dataUrl, createdAt: info.createdAt, source: info.source })
      imageCache.set(id, dataUrl)
    }

    for (const task of data.tasks) {
      await putTask({ ...task, ownerUserId: currentUser.id })
    }

    if (data.settings) {
      useStore.getState().setSettings(data.settings)
    }

    await loadLocalTasksForUser(currentUser)
    useStore
      .getState()
      .showToast(`已导入 ${data.tasks.length} 条记录`, 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

/** 添加图片到输入（文件上传）—— 仅放入内存缓存，不写 IndexedDB */
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  const id = await hashDataUrl(dataUrl)
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await hashDataUrl(dataUrl)
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
