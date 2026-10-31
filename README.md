<p align="center">
  <img src="https://app.pug.sh/logo.svg" alt="Pug" width="120" height="120" />
</p>

# @pug-sh/node

Pug server-side SDK for Node.js: event tracking, profile identify, and analytics reads.

It is instance-based and authenticates with a **private** project API key (`prv_…`). Ingestion
never throws, so a tracking call can't take down your request path.

## Install

```bash
npm install @pug-sh/node   # or: bun add @pug-sh/node / pnpm add @pug-sh/node / yarn add @pug-sh/node
```

Requires Node.js 18 or newer.

## Quick start

```ts
import { Pug } from '@pug-sh/node'

const pug = new Pug({
  apiKey: process.env.PUG_API_KEY!,
  endpoint: 'https://pug.example.com',
})

// Track an event. `distinctId` (who the event is for) comes first; a server has no ambient user.
pug.track('user_42', 'order.completed', { amount: 49.0, currency: 'USD' })

// Well-known events get typed properties (autocomplete + validation).
pug.track('user_42', 'feature_used', { featureId: 'export' })

// Identify a profile. Queued and sent in batches like events; never throws.
pug.identify('user_42', { email: 'ada@example.com', plan: 'pro' })

// Reads (require a private key; throw PugError).
const profile = await pug.profiles.getByExternalId('user_42')
for await (const p of pug.profiles.list()) {
  console.log(p.externalId)
}
const trend = await pug.insights.query({
  /* spec, timeRange, granularity */
})

// Drain on shutdown so nothing queued is lost.
await pug.close()
```

## Behaviour

- **Ingestion never throws.** `track()` and `identify()` validate input client-side and log +
  drop on bad input. Both are non-blocking: events and identifies each have a queue that flushes
  by size (`maxSize`) or interval (`maxWaitMs`).
- **Delivery is best-effort with retry.** Transient send failures keep events and identifies
  queued and retry; permanent failures (a fixed set of client-error gRPC codes, plus any
  non-transport error) dead-letter via `onError`. `close()` drains and reports anything still
  undelivered through `onError`.
- **Identifies go out with `BatchIdentify`.** A server that predates it gets one `Identify` call
  per identify instead.
- **Reads are request/response and do throw** `PugError`. They run in your control flow, so you
  own timeout/retry. They are not auto-retried.
- **Well-known events** have typed, validated properties; any other string `kind` is accepted as
  a custom event with loose properties.

## API

### `new Pug(options)`

| Option     | Type                   | Default         | Description                                                                             |
| ---------- | ---------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `apiKey`   | `string`               | -               | **Required.** Private project key (`prv_…`).                                            |
| `endpoint` | `string`               | hosted endpoint | Pug server origin.                                                                      |
| `batch`    | `Partial<BatchConfig>` | see below       | Batching overrides; the event and identify queues each get these settings.              |
| `onError`  | `(err, lost) => void`  | no-op           | Dead-letter / diagnostics hook for queued events and identifies that weren't delivered. |

```ts
new Pug({
  apiKey, // required, prv_…
  endpoint, // default: hosted endpoint
  batch: { maxSize: 100, maxWaitMs: 5000, maxQueueSize: 10_000 },
  onError: (err, { events, identifies }) => {
    /* dead-letter sink; one of the two lists is empty */
  },
})
```

### Ingestion (never throws)

- `pug.track(distinctId, kind, props?, options?)`: enqueue an event. Non-blocking.
- `pug.identify(externalId, traits?, options?)`: queue a create-or-update of a profile; traits
  are shallow-merged into the stored ones. Non-blocking.
- `pug.flush()`: send the queued events and identifies now.
- `pug.close()`: drain and shut down; call on graceful exit so nothing queued is lost.

`track` options: `timestamp` (epoch ms override), `sessionId` (per-call session override),
`location` (the visitor's location, see below).
`identify` options: `anonymousId` (must start with `anon-`; triggers anon→identified merge),
`deviceId`. A trait holding `NaN` or `Infinity` is skipped with a warning, as `track()` skips such
a property; the server would store it as a string. An event or identify over 900 KiB is dropped at
the call, to stay clear of the server's 1 MiB message limit.

Pug only derives geo from CDN headers on browser (public-key) requests. This SDK uses a
private key, so the server adds no geo of its own; without `location`, an event has no geo
at all:

```ts
pug.track(
  'user-123',
  'checkout_completed',
  { plan: 'pro' },
  {
    location: { country: 'DE', city: 'Berlin' },
  },
)
```

Fields: `continent`, `country`, `region`, `city`, `postalCode`, `metroCode`, `timezone`,
`latitude`, `longitude`: strings, except the two coordinates. `country` must be an ISO
3166-1 alpha-2 code (case and surrounding spaces are normalized); `latitude` and `longitude`
are only sent as a pair.

A field that is missing, null or empty is omitted silently. One that looks like a mistake
(unknown key, wrong type, unknown country, coordinate out of range) is dropped with a
warning and the rest is still sent. If nothing is usable the event goes out with no geo.

### Reads (throw `PugError`)

These require a private key and run in your control flow:

- `pug.profiles`: `get`, `getByExternalId`, `delete`, `list` (auto-paginating async iterator).
- `pug.activity`: `feed`, `eventExplorer`, `heatmap`, `profileSessions`, `profileStats`, `filterSchema`,
  `propertyValues`.
- `pug.insights`: `query`, `segmentUsers`, `filterSchema`, `propertyValues`.

Reads leave out traffic tagged as a bot at ingest unless you set `includeBots: true` (for
`profiles.get` and `getByExternalId`, pass it as a second argument).

Errors normalize to `PugError`, which carries the underlying Connect `code` and `cause`.

## Contributing

See [`docs/development.md`](./docs/development.md) for building, testing, and how the well-known
event catalog is generated.

## License

MIT
