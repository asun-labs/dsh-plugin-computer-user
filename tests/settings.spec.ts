import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { Config, SETTINGS_DEFAULTS, resolveSettings } from '../src/config.ts'

it('persists settings through the DSH 0.2 profile entry and keeps failed writes out of memory', async () => {
  expect(Config.dict?.capture_interval_ms?.meta.volatile).toBe(true)
  expect(resolveSettings(Config({ ...SETTINGS_DEFAULTS, link_mode: 'real', capture_interval_ms: 1600 }))).toMatchObject({
    link_mode: 'real', capture_interval_ms: 1600,
  })
  const routes = new Map<string, (request: Request) => Promise<Response> | Response>()
  const warnings: string[] = []
  let rejectWrite = false
  let describeCalls = 0
  const update = vi.fn(async (_ns: string, _patch: object) => {
    if (rejectWrite) throw new Error('write refused')
  })
  const settings = {
    describe: () => ++describeCalls === 1 ? [] : [{ ns: 'dsh-computer-user', value: SETTINGS_DEFAULTS }],
    update,
  }
  const ctx = {
    tools: { register: () => () => undefined },
    effect: (register: () => unknown) => { register() },
    inject: (services: string[], callback: (value: unknown) => void) => {
      if (services.includes('settings')) callback({ settings })
    },
    on: () => () => undefined,
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> | Response }) => {
      routes.set(route.path, route.fetch)
      return async () => undefined
    } } },
    logger: { warn: (message: string) => warnings.push(message) },
  } as unknown as Context

  await apply(ctx, { ...SETTINGS_DEFAULTS, capture_interval_ms: 0 })
  expect(warnings).toEqual([])
  const route = routes.get('/api/computer-user/settings')!
  const post = (linkMode: string) => route(new Request('http://localhost/api/computer-user/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ link_mode: linkMode }),
  }))
  const get = () => route(new Request('http://localhost/api/computer-user/settings'))

  expect((await post('real')).status).toBe(200)
  expect(update).toHaveBeenCalledWith('dsh-computer-user', { link_mode: 'real' })
  expect((await (await get()).json()).link_mode).toBe('real')

  rejectWrite = true
  expect((await post('virtual')).status).toBe(400)
  expect((await (await get()).json()).link_mode).toBe('real')
})
