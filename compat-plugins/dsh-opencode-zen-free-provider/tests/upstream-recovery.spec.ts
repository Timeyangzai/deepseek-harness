/** The first recoverable upstream refusal of a request is re-routed, not shown. */
import { expect, it } from 'vitest'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { recoverableUpstreamFailure, withUpstreamRecovery } from '../lib/index.js'

type Event = { type: string; error?: { errorMessage: string }; text?: string }

function fakeStream() {
  const events: Event[] = []
  return {
    events,
    push(event: Event) { events.push(event) },
    result: () => Promise.resolve(undefined),
  }
}

const failure = (type: string, message: string): Event => ({
  type: 'error',
  error: { errorMessage: '500 {"type":"' + type + '","message":"' + message + '"} ' },
})

function compose(plan: readonly { label: string }[]) {
  const streams: ReturnType<typeof fakeStream>[] = []
  const switches: string[] = []
  const outward = withUpstreamRecovery(
    plan,
    (attempt) => {
      const stream = fakeStream()
      streams.push(stream)
      expect(attempt).toBe(plan[streams.length - 1])
      return stream
    },
    (from, to, error) => { switches.push(from.label + '->' + to.label + ':' + error.type) },
  )
  return { outward, streams, switches }
}

it('classifies the refusal classes worth another route', () => {
  expect(recoverableUpstreamFailure(failure('server_error', 'Upstream request failed: Endpoint is unavailable.')))
    .toEqual({ type: 'server_error', code: '', message: 'Upstream request failed: Endpoint is unavailable.' })
  expect(recoverableUpstreamFailure(failure('FreeUsageLimitError', 'Rate limit exceeded. Please try again later.'))).toBeUndefined()
  expect(recoverableUpstreamFailure({ type: 'text', text: 'hello' })).toBeUndefined()
  expect(recoverableUpstreamFailure(failure('AuthError', 'invalid api key'))).toBeUndefined()
  expect(recoverableUpstreamFailure({ type: 'error', error: { errorMessage: 'Endpoint is unavailable' } })).toBeUndefined()
  expect(recoverableUpstreamFailure({ type: 'error', error: { errorMessage: '[opencode-zen server_error] Endpoint is unavailable' } })).toMatchObject({ type: 'server_error' })
  expect(recoverableUpstreamFailure({ type: 'error', error: { errorMessage: '429 {"error":{"type":"server_error","message":"Endpoint is unavailable"}}' } })).toMatchObject({ type: 'server_error' })
  expect(recoverableUpstreamFailure(failure('AuthError', 'Endpoint is unavailable'))).toBeUndefined()
})

it('swallows the first refusal and answers from the next attempt', () => {
  const { outward, streams, switches } = compose([{ label: 'glm' }, { label: 'glm on responses' }])
  streams[0].push(failure('server_error', 'Upstream request failed: Endpoint is unavailable.'))
  expect(switches).toEqual(['glm->glm on responses:server_error'])
  expect(outward.events).toEqual([])
  expect(streams).toHaveLength(2)
  streams[1].push({ type: 'text', text: 'answered elsewhere' })
  streams[1].push({ type: 'done' })
  expect(outward.events).toEqual([{ type: 'text', text: 'answered elsewhere' }, { type: 'done' }])
})

it('forwards a non-recoverable refusal without a second attempt', () => {
  const { outward, streams, switches } = compose([{ label: 'glm' }, { label: 'deepseek' }])
  const denied = failure('AuthError', 'invalid api key')
  streams[0].push(denied)
  expect(switches).toEqual([])
  expect(streams).toHaveLength(1)
  expect(outward.events).toEqual([denied])
})

it('shows the last refusal when every attempt refuses', () => {
  const { outward, streams } = compose([{ label: 'a' }, { label: 'b' }, { label: 'c' }])
  streams[0].push(failure('server_error', 'Endpoint is unavailable.'))
  streams[1].push(failure('server_error', 'Please try again later.'))
  streams[2].push(failure('server_error', 'Upstream request failed: Endpoint is unavailable.'))
  expect(streams).toHaveLength(3)
  expect(outward.events).toEqual([failure('server_error', 'Upstream request failed: Endpoint is unavailable.')])
})

it('keeps the earlier refusal when the next attempt cannot start', () => {
  const original = failure('server_error', 'Upstream request failed: Endpoint is unavailable.')
  const outward = fakeStream()
  let started = 0
  const stream = withUpstreamRecovery(
    [{ label: 'a' }, { label: 'b' }],
    () => {
      started += 1
      if (started === 2) throw new Error('stream factory failed')
      return outward
    },
    () => {},
  )
  stream.push(original)
  expect(started).toBe(2)
  expect(outward.events).toEqual([original])
})

it('passes a single-attempt plan straight through', () => {
  const { outward, streams, switches } = compose([{ label: 'only' }])
  const original = failure('server_error', 'Endpoint is unavailable.')
  streams[0].push(original)
  expect(switches).toEqual([])
  expect(outward.events).toEqual([original])
})

it('does not retry after partial content or cancellation', () => {
  const { outward, streams, switches } = compose([{ label: 'a' }, { label: 'b' }])
  streams[0].push({ type: 'start' })
  streams[0].push({ type: 'text', text: 'partial' })
  const denied = failure('server_error', 'Endpoint is unavailable.')
  streams[0].push(denied)
  expect(outward.events).toEqual([{ type: 'start' }, { type: 'text', text: 'partial' }, denied])
  expect(switches).toEqual([])
  const cancelled = fakeStream()
  let attempts = 0
  withUpstreamRecovery(['a', 'b'], () => { attempts++; return cancelled }, () => {}, AbortSignal.abort())
  cancelled.push(denied)
  expect(attempts).toBe(1)
  expect(cancelled.events).toEqual([denied])
})

it('keeps real iteration and result pending until the replacement stream completes', async () => {
  const first = new AssistantMessageEventStream()
  const second = new AssistantMessageEventStream()
  const message: AssistantMessage = {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'opencode', model: 'glm',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 0,
  }
  const stream = withUpstreamRecovery([0, 1], i => i === 0 ? first : second, () => {})
  const observed = (async () => { const events = []; for await (const event of stream) events.push(event); return events })()
  first.push({ type: 'start', partial: message })
  first.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: '[opencode-zen server_error] Endpoint is unavailable' } })
  first.end()
  second.push({ type: 'start', partial: message })
  second.push({ type: 'done', reason: 'stop', message })
  second.end()
  expect((await observed).map(event => event.type)).toEqual(['start', 'done'])
  expect(await stream.result()).toEqual(message)
})
