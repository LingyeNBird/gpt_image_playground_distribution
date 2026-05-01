export type BucketFormFields = Record<string, FormDataEntryValue>

export type EditableBucket = {
  name?: string
  region?: string
  bucket?: string
  secretId?: string
  secretKey?: string
  pathPrefix?: string
  tempUrlMinutes?: number
}

export type BucketConfirmAction = 'add' | 'delete'

export function evaluateMinuteExpression(value: string) {
  const source = value.trim()
  if (!source) return 0
  if (!/^[\d+\-*/().\s]+$/.test(source)) return -1
  try {
    const result = Function(`"use strict"; return (${source})`)()
    if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) return -1
    return Math.round(result)
  } catch {
    return -1
  }
}

export function normalizeMinuteInput(input: HTMLInputElement) {
  const result = evaluateMinuteExpression(input.value)
  if (result >= 0) input.value = result ? String(result) : ''
}

export function bucketPayloadFromFields(fields: BucketFormFields) {
  const tempUrlMinutes = evaluateMinuteExpression(String(fields.tempUrlMinutes || '0'))
  if (tempUrlMinutes < 0) {
    throw new Error('临时链接分钟数表达式不正确')
  }
  return {
    name: String(fields.name || '').trim(),
    region: String(fields.region || '').trim(),
    bucket: String(fields.bucket || '').trim(),
    secretId: String(fields.secretId || '').trim(),
    secretKey: String(fields.secretKey || ''),
    pathPrefix: String(fields.pathPrefix || '').trim(),
    tempUrlMinutes,
  }
}

export function bucketEditDefaults(bucket: EditableBucket | null) {
  return {
    name: bucket?.name ?? '',
    region: bucket?.region ?? '',
    bucket: bucket?.bucket ?? '',
    secretId: bucket?.secretId ?? '',
    secretKey: bucket?.secretKey ?? '',
    pathPrefix: bucket?.pathPrefix ?? '',
    tempUrlMinutes: bucket?.tempUrlMinutes ? String(bucket.tempUrlMinutes) : '',
  }
}

export function bucketConfirmCopy(action: BucketConfirmAction, bucketName: string) {
  const name = bucketName.trim() || '未命名存储桶'
  if (action === 'add') {
    return {
      title: '确认添加存储桶',
      detail: `即将添加存储桶“${name}”，添加后启用存储桶模式的用户可使用该配置保存图片。`,
      confirmText: '确认添加',
    }
  }
  return {
    title: '确认删除存储桶',
    detail: `确定删除存储桶“${name}”？删除后不会删除 COS 中已有文件，但用户将不能继续使用该配置保存新图片。`,
    confirmText: '确认删除',
  }
}

export function toastTypeForError(error: unknown): 'success' | 'error' {
  return error ? 'error' : 'success'
}
