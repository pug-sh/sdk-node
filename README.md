# sdk-node

Pug server-side SDK for Node.js — event tracking, profile identify, and analytics reads.

It is instance-based and authenticates with a **private** project API key (`prv_…`). Ingestion
never throws, so a tracking call can't take down your request path.

## Install

```bash
npm install sdk-node   # or: bun add sdk-node / pnpm add sdk-node / yarn add sdk-node
```

Requires Node.js 18 or newer.

## Quick start

```ts
import { Pug } from 'sdk-node'

const pug = new Pug({ apiKey: process.env.PUG_API_KEY!, baseUrl: 'https://pug.example.com' })

// Track an event. `distinctId` (who the event is for) comes first — a server has no ambient user.
pug.track('user_42', 'order.completed', { amount: 49.0, currency: 'USD' })

// Well-known events get typed properties (autocomplete + validation).
pug.track('user_42', 'feature_used', { feature_name: 'export' })

// Identify a profile (never throws — failures are logged).
await pug.identify('user_42', { email: 'ada@example.com', plan: 'pro' })

// Reads (require a private key; throw PugError).
const profile = await pug.profiles.getByExternalId('user_42')
for await (const p of pug.profiles.list()) {
  console.log(p.externalId)
}
const trend = await pug.insights.query({ /* spec, timeRange, granularity */ })

// Drain on shutdown so no buffered events are lost.
await pug.close()
```

## Behaviour

- **Ingestion never throws.** `track()` and `identify()` validate input client-side and log +
  drop on bad input. `track()` is non-blocking — events batch and flush by size (`maxSize`) or
  interval (`maxWaitMs`).
- **Delivery is best-effort with retry.** Transient send failures keep events queued and retry;
  permanent failures (a fixed set of client-error gRPC codes, plus any non-transport error)
  dead-letter via `onError`. `close()` drains and reports anything still undelivered through
  `onError`. `onError` covers buffered `track()` events only — `identify()` failures are logged.
- **Reads are request/response and do throw** `PugError` — they run in your control flow, so you
  own timeout/retry. They are not auto-retried.
- **Well-known events** have typed, validated properties; any other string `kind` is accepted as
  a custom event with loose properties.

## API

### `new Pug(options)`

| Option    | Type                      | Default           | Description                                              |
| --------- | ------------------------- | ----------------- | -------------------------------------------------------- |
| `apiKey`  | `string`                  | —                 | **Required.** Private project key (`prv_…`).             |
| `baseUrl` | `string`                  | hosted endpoint   | Pug server origin.                                       |
| `batch`   | `Partial<BatchConfig>`    | see below         | Batching overrides for the ingestion buffer.            |
| `onError` | `(err, events) => void`   | no-op             | Dead-letter / diagnostics hook for undeliverable buffered `track()` events (`identify` failures are logged, not routed here). |

```ts
new Pug({
  apiKey,                 // required, prv_…
  baseUrl,                // default: hosted endpoint
  batch: { maxSize: 100, maxWaitMs: 5000, maxQueueSize: 10_000 },
  onError: (err, events) => { /* dead-letter sink */ },
})
```

### Ingestion (never throws)

- `pug.track(distinctId, kind, props?, options?)` — enqueue an event. Non-blocking.
- `pug.identify(externalId, traits?, options?)` — create or update a profile.
- `pug.flush()` — send the currently-buffered events now.
- `pug.close()` — drain and shut down; call on graceful exit so nothing buffered is lost.

`track` options: `timestamp` (epoch ms override), `sessionId` (per-call session override).
`identify` options: `anonymousId` (must start with `anon-`; triggers anon→identified merge),
`deviceId`.

### Reads (throw `PugError`)

These require a private key and run in your control flow:

- `pug.profiles` — `get`, `getByExternalId`, `delete`, `list` (auto-paginating async iterator).
- `pug.activity` — `feed`, `eventExplorer`, `heatmap`, `profileStats`, `filterSchema`, `propertyValues`.
- `pug.insights` — `query`, `segmentUsers`, `filterSchema`, `propertyValues`.

Errors normalize to `PugError`, which carries the underlying Connect `code` and `cause`.

## Contributing

See [`docs/development.md`](./docs/development.md) for building, testing, and how the well-known
event catalog is generated.

## License

AGPL-3.0-or-later
