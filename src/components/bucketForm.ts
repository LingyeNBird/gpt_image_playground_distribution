export type BucketFormFields = Record<string, FormDataEntryValue>

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
