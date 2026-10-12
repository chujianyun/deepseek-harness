import { describe, expect, it } from 'vitest'
import { userCenterRefusal } from '../src/index.ts'

describe('userCenterRefusal', () => {
  it('reads the user center\'s message, joins a list, and falls back to the status', async () => {
    const answer = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'application/json' } })
    expect(await userCenterRefusal(answer('{"message":"会话不存在"}', 404))).toEqual({ reason: '会话不存在', status: 404 })
    expect(await userCenterRefusal(answer('{"message":["标题太长","图片太大"]}', 400))).toEqual({ reason: '标题太长；图片太大', status: 400 })
    expect(await userCenterRefusal(answer('{"error":"x"}', 500))).toEqual({ reason: 'the user center answered 500', status: 500 })
    expect(await userCenterRefusal(answer('not json', 502))).toEqual({ reason: 'the user center answered 502', status: 502 })
  })
})
