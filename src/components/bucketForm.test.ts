import { describe, expect, it } from 'vitest'
import { bucketPayloadFromFields, evaluateMinuteExpression } from './bucketForm'

describe('bucket form helpers', () => {
  it('evaluates temporary URL minute expressions', () => {
    expect(evaluateMinuteExpression('60*24')).toBe(1440)
    expect(evaluateMinuteExpression('2880')).toBe(2880)
    expect(evaluateMinuteExpression('')).toBe(0)
    expect(evaluateMinuteExpression('alert(1)')).toBe(-1)
  })

  it('builds bucket payload without bucket URL', () => {
    expect(bucketPayloadFromFields({
      name: ' 我的腾讯云 ',
      region: ' ap-nanjing ',
      bucket: ' gptimage-1325670071 ',
      secretId: 'sid',
      secretKey: 'skey',
      pathPrefix: ' image_playground ',
      tempUrlMinutes: '60*48',
    })).toEqual({
      name: '我的腾讯云',
      region: 'ap-nanjing',
      bucket: 'gptimage-1325670071',
      secretId: 'sid',
      secretKey: 'skey',
      pathPrefix: 'image_playground',
      tempUrlMinutes: 2880,
    })
  })

  it('rejects invalid minute expressions', () => {
    expect(() => bucketPayloadFromFields({ tempUrlMinutes: '1 day' })).toThrow('临时链接分钟数表达式不正确')
  })
})
