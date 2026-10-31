import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { afterEach, expect, it, vi } from 'vitest'
import { type Event, EventsService } from './gen/sdk/events/v1/events_pb.js'
import { type IdentifyRequest, ProfilesSDKService } from './gen/sdk/profiles/v1/profiles_pb.js'
import { type OnError, Pug } from './pug.js'

const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(stops.splice(0).map(stop => stop()))
  vi.restoreAllMocks()
})

// Serves the routes on a free localhost port and returns a client pointed at it.
const startServer = async (routes: (router: ConnectRouter) => void, onError?: OnError) => {
  const server = createServer(connectNodeAdapter({ routes }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  stops.push(
    () =>
      new Promise(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const { port } = server.address() as AddressInfo
  return new Pug({ apiKey: 'prv_test', endpoint: `http://127.0.0.1:${port}`, onError })
}

const externalIds = (reqs: IdentifyRequest[]) => reqs.map(req => req.externalId)

it('close() delivers queued events, and identifies in one BatchIdentify call', async () => {
  const events: Event[] = []
  const batches: IdentifyRequest[][] = []
  const apiKeys: (string | null)[] = []
  const pug = await startServer(router => {
    router.service(EventsService, {
      batchCreate: req => {
        events.push(...req.events)
        return { accepted: req.events.length }
      },
    })
    router.service(ProfilesSDKService, {
      batchIdentify: (req, ctx) => {
        batches.push(req.identifies)
        apiKeys.push(ctx.requestHeader.get('x-api-key'))
        return { accepted: req.identifies.length }
      },
    })
  })

  pug.track('user_1', 'my.custom')
  pug.identify('user_1', { plan: 'pro' }, { anonymousId: 'anon-1' })
  pug.identify('user_2')
  await pug.close()

  expect(events.map(e => e.kind)).toEqual(['my.custom'])
  expect(batches).toHaveLength(1)
  expect(batches[0]?.[0]).toMatchObject({ externalId: 'user_1', traits: { plan: 'pro' }, anonymousId: 'anon-1' })
  expect(externalIds(batches[0] ?? [])).toEqual(['user_1', 'user_2'])
  expect(apiKeys).toEqual(['prv_test'])
})

it('sends one Identify call per item to a server without BatchIdentify', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const identified: IdentifyRequest[] = []
  // Registering Identify alone leaves BatchIdentify unrouted, so it gets a real 404.
  const pug = await startServer(router => {
    router.rpc(ProfilesSDKService.method.identify, req => {
      identified.push(req)
      return {}
    })
  })

  pug.identify('user_1')
  pug.identify('user_2')
  await pug.flush()
  pug.identify('user_3')
  await pug.close()

  expect(externalIds(identified)).toEqual(['user_1', 'user_2', 'user_3'])
  expect(warn.mock.calls.filter(([msg]) => String(msg).includes('no BatchIdentify'))).toHaveLength(1)
})

it('retries a fallback that failed partway from the first identify it did not deliver', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const identified: IdentifyRequest[] = []
  let failNext = true
  const pug = await startServer(router => {
    router.rpc(ProfilesSDKService.method.identify, req => {
      if (req.externalId === 'user_2' && failNext) {
        failNext = false
        throw new ConnectError('try again', Code.Unavailable)
      }
      identified.push(req)
      return {}
    })
  })

  pug.identify('user_1')
  pug.identify('user_2')
  pug.identify('user_3')
  await pug.flush()
  await pug.flush()

  expect(externalIds(identified)).toEqual(['user_1', 'user_2', 'user_3'])
  await pug.close()
})

it('reports what each queue loses to onError, with the other list empty', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const onError = vi.fn<OnError>()
  const refuse = () => {
    throw new ConnectError('refused', Code.InvalidArgument)
  }
  const pug = await startServer(router => {
    router.service(EventsService, { batchCreate: refuse })
    router.service(ProfilesSDKService, { batchIdentify: refuse })
  }, onError)

  pug.track('user_1', 'my.custom')
  pug.identify('user_1')
  await pug.close()

  const reports = onError.mock.calls.map(([err, lost]) => ({
    code: (err as ConnectError).code,
    events: lost.events.map(e => e.kind),
    identifies: externalIds(lost.identifies),
  }))
  expect(reports).toHaveLength(2)
  expect(reports).toEqual(
    expect.arrayContaining([
      { code: Code.InvalidArgument, events: ['my.custom'], identifies: [] },
      { code: Code.InvalidArgument, events: [], identifies: ['user_1'] },
    ]),
  )
})

it("cuts each queue's requests at its byte limit", async () => {
  const eventBatches: number[] = []
  const identifyBatches: number[] = []
  const pug = await startServer(router => {
    router.service(EventsService, {
      batchCreate: req => {
        eventBatches.push(req.events.length)
        return { accepted: req.events.length }
      },
    })
    router.service(ProfilesSDKService, {
      batchIdentify: req => {
        identifyBatches.push(req.identifies.length)
        return { accepted: req.identifies.length }
      },
    })
  })

  // About 200 KB per event against 512 KiB per request, and 800 KiB per identify against 4 MiB.
  const props = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, 'x'.repeat(1000)]))
  for (let i = 0; i < 3; i++) {
    pug.track('user_1', 'my.custom', props)
  }
  for (let i = 0; i < 6; i++) {
    pug.identify(`user_${i}`, { blob: 'x'.repeat(800 << 10) })
  }
  await pug.close()

  expect(eventBatches).toEqual([2, 1])
  expect(identifyBatches).toEqual([5, 1])
})
