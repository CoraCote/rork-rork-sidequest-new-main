# NestJS Backend — Full Architecture Reference

This document covers the `server/` directory: a NestJS backend that replaced the original Hono-based `backend/` codebase. It handles event ingestion from multiple sources, nightlife venue discovery, Google review enrichment, snapshot building, and viewport tile materialization for the SideQuest iOS app.

---

## 1. Why It Was Built

The original backend lived in `backend/` and ran on Fly.io as a standalone Hono + TypeScript worker. It was functional but not modular — adapters, helpers, config, and the ingestion worker were all loosely coupled files with no dependency injection, no validation pipeline, and no consistent structure.

The NestJS rewrite in `server/` ports every piece of that codebase into a proper modular architecture:

- **Modules** for each route domain (trigger, ingestion, debug, worker)
- **Injectable helpers** instead of standalone adapter files
- **Global providers** for shared services (Supabase, NormalizeHelper, GeoHelper)
- **Zod env validation** at startup (not runtime checks scattered through code)
- **Pino structured JSON logging** (not `console.log` strings)
- **Rate limiting** via `@nestjs/throttler` (3-tier: burst, sustained, throughput)
- **Helmet** for HTTP security headers

---

## 2. Project Structure

```
server/src/
  main.ts                    # Bootstrap: Pino logger, CORS, helmet, validation pipe
  app.module.ts              # Root module: config, throttler, logger, all route modules
  shared.module.ts           # @Global: NormalizeHelper, GeoHelper (used by many services)
  supabase.module.ts         # @Global: SupabaseClient via useFactory (direct class injection)

  config/
    configuration.ts         # Config factory: port, supabase, worker, apiKeys
    env.validation.ts        # Zod schema: validates all env vars at startup

  utils/
    types.ts                 # All shared interfaces (EventResult, AdapterResult, MetroRecord,
                             #   NightlifeVenue, BuiltSnapshot, SnapshotEvent, WorkerConfig,
                             #   TmEvent, Eventbrite types, Google types, RunSignup types)
    enums.ts                 # Intent, JobStatus, SourceType, DEFAULT_INTENTS, POI_CATEGORIES

  helpers/                   # All injectable services — NO adapters/ folder
    ticketmaster.helper.ts   # Ticketmaster Discovery API client
    eventbrite.helper.ts     # Eventbrite HTML scraper (no API key)
    google-events.helper.ts  # Google Events HTML scraper (no API key)
    runsignup.helper.ts      # RunSignup public API client (no API key)
    nightlife-enrichment.helper.ts  # Discotech, Clubbable, HWood scraper
    google-reviews.helper.ts # Google review signal scraper + venue review cache
    snapshot-builder.helper.ts  # Event dedup + snapshot assembly
    normalize.helper.ts      # Text normalization, dedup keys, review sanitization
    tile-math.helper.ts      # Web Mercator tile math (latLonToTile, tileBounds, etc.)
    geo.helper.ts            # Geo utilities (haversine, coverage selection)

  routes/
    trigger/                 # Enqueues refresh jobs into refresh_jobs table
      trigger.controller.ts  # 7 POST endpoints
      trigger.service.ts     # Job enqueueing, metro lookup, staleness checks
      trigger.module.ts
    ingestion/               # Read-only status/health endpoints
      ingestion.controller.ts  # GET /status, GET /source-health
      ingestion.service.ts   # Queries refresh_jobs, refresh_runs, source_health
      ingestion.module.ts
    debug/                   # Review scraping test + venue cache inspection
      debug.controller.ts    # 7 endpoints (GET + POST)
      debug.service.ts       # Scrape venue reviews, cache lookup, clear cache
      debug.module.ts
    worker/                  # The actual ingestion engine
      worker.controller.ts   # POST /start, DELETE /stop, GET /status
      worker.service.ts      # Poll loop, job processing, tile materialization
      worker.module.ts

  dtos/                      # Request validation DTOs (class-validator decorators)
    trigger/                 # TriggerRefreshDto, TriggerBackfillDto, etc.
    debug/                   # TestReviewQueryDto, ScrapeAndCacheDto, etc.
```

---

## 3. Dependency Injection Pattern

### Supabase

Provided globally via `SupabaseModule` using `useFactory`:

```typescript
// supabase.module.ts
@Global()
@Module({
  providers: [{
    provide: SupabaseClient,
    useFactory: (configService: ConfigService): SupabaseClient => {
      return createClient(url, key, { auth: { persistSession: false } });
    },
    inject: [ConfigService],
  }],
  exports: [SupabaseClient],
})
```

Injected in services as a plain constructor parameter — **no `@Inject()` decorator needed**:

```typescript
constructor(private readonly supabase: SupabaseClient) {}
```

### Shared Helpers

`NormalizeHelper` and `GeoHelper` are in the `@Global() SharedModule`, so they're available everywhere without importing the module.

### Route-Specific Helpers

Helpers like `TicketmasterHelper`, `EventbriteHelper`, etc. are listed as `providers` in the module that uses them (e.g., `WorkerModule`). They are NOT global.

---

## 4. The Two-Part Ingestion Flow

### Part 1: TriggerService (enqueue jobs)

The trigger service decides **what** needs refreshing and inserts rows into `refresh_jobs`. It never does any scraping itself.

**Trigger sources:**
- Supabase `pg_cron` (migration 00004) calls `POST /api/trigger-backfill` on a schedule
- iOS app can fire `POST /api/trigger-refresh` when cache is stale
- Manual curl calls for ad-hoc refreshes

**Trigger endpoints:**

| Endpoint | What it does |
|----------|-------------|
| `POST /trigger-refresh` | Enqueue one metro + one intent |
| `POST /trigger-backfill` | Enqueue all metros at or below a tier |
| `POST /trigger-metro-refresh` | Enqueue all intents for one metro |
| `POST /trigger-tile-scrape` | Find nearby metros for a tile, enqueue them |
| `POST /trigger-metro-batch` | Enqueue only stale intents for a metro |
| `POST /trigger-on-demand-tile` | Like tile-scrape but checks freshness first |
| `POST /trigger-poi-refresh` | Seed empty POI tiles for a metro (direct write) |

**Deduplication:** Before inserting, `enqueueJobs()` queries `refresh_jobs` for any `pending`/`claimed` jobs with the same `metro_id + intent` and skips duplicates.

### Part 2: WorkerService (process jobs)

The worker service polls `refresh_jobs`, claims jobs, and processes them.

**Lifecycle:**

```
POST /worker/start
  -> startWorker()
    -> enqueueScheduledRefreshes() RPC (initial)
    -> setInterval: reclaimStaleJobs() + enqueueScheduledRefreshes() every 60s
    -> pollLoop() (background, non-blocking)
      -> claimJob() via claim_refresh_job RPC
      -> getMetro() from ingestion_metros
      -> processJob(job, metro)
        -> fetch from 4 adapters in parallel
        -> enrichEventsWithNightlife()
        -> enrichEventsWithReviews()
        -> buildSnapshot()
        -> upsertSnapshot() -> external_event_snapshots
        -> materializeViewportTiles() -> external_event_viewport_tiles
        -> recordSourceHealth() -> source_health
        -> recordCoverageMetrics() -> coverage_metrics
        -> updateRefreshRun() -> refresh_runs
      -> completeJob() via complete_refresh_job RPC
```

**Job lifecycle RPCs:**

| Operation | RPC used |
|-----------|----------|
| Claim a job | `claim_refresh_job(p_worker_id)` |
| Heartbeat | `heartbeat_refresh_job(p_job_id, p_worker_id)` |
| Complete | `complete_refresh_job(p_job_id, p_worker_id)` |
| Fail | `fail_refresh_job(p_job_id, p_worker_id, p_error_message)` |
| Reclaim stale | `reclaim_stale_jobs(p_heartbeat_timeout_minutes)` |
| Auto-enqueue | `enqueue_scheduled_refreshes()` |

---

## 5. Data Sources (Helpers)

### Ticketmaster (`ticketmaster.helper.ts`)
- **Auth:** `TICKETMASTER_API_KEY` (required, validated by Zod)
- **Method:** REST API (`app.ticketmaster.com/discovery/v2/events`)
- **What:** Concerts, sports, theater, comedy — structured JSON
- **Key logic:** `CLASSIFICATION_CHANNELS` maps intents to genre filters, `pickBestImage()` selects 16:9 ratio images, `mapTmStatus()` normalizes sale status

### Eventbrite (`eventbrite.helper.ts`)
- **Auth:** None (scrapes public HTML)
- **Method:** Fetches Eventbrite search pages, extracts JSON-LD `ItemList` blocks
- **What:** Community events, workshops, festivals, social gatherings
- **Key logic:** `buildChannels()` creates search URLs per intent, `extractJsonLd()` parses `<script type="application/ld+json">`, `dedupeEvents()` removes exact title+date duplicates

### Google Events (`google-events.helper.ts`)
- **Auth:** None (scrapes public HTML)
- **Method:** Google Search with `ibp=htl;events` parameter
- **What:** Aggregated events from Google's event cards
- **Key logic:** `parseGoogleCards()` extracts structured data from HTML, `parseGoogleWhen()` handles relative dates ("Tomorrow", "Sat, Apr 15"), `timeZoneForMetro()` maps metros to IANA timezones

### RunSignup (`runsignup.helper.ts`)
- **Auth:** None (public API)
- **Method:** REST API (`runsignup.com/rest/races`)
- **What:** Running races, marathons, 5Ks, obstacle courses
- **Key logic:** Two-pass fetch (list then detail), `classifyRunEvent()` infers type from distance/name, supports virtual events

### Nightlife Enrichment (`nightlife-enrichment.helper.ts`)
- **Auth:** None (scrapes public HTML)
- **Sources:** Discotech, Clubbable, HWood Rolodex
- **What:** Nightclubs, lounges, VIP venues — with cover prices, table minimums, dress codes, guest lists
- **Key logic:** Market page scraping with fallback sources (guest lists, bottle service, category pages, Google Search discovery), venue deduplication via fuzzy name matching, `computeNightlifeSignalScore()` and `computePrestigeScore()` for ranking
- **Markets:** 24 cities (LA, NYC, Miami, Vegas, Chicago, Austin, Nashville, etc.)

### Google Reviews (`google-reviews.helper.ts`)
- **Auth:** None (scrapes public HTML)
- **Method:** Google Search + Google Maps HTML scraping
- **What:** Venue ratings and review counts to enrich events
- **Key logic:** Multi-signal scraping (map search, HTML search, Maps URL), `reconcileSignals()` cross-validates map vs HTML signals, `venueIdentityScore()` prevents poisoned data (wrong venue matched), writes to `venue_review_cache` table with 7-day TTL and poison detection

### Snapshot Builder (`snapshot-builder.helper.ts`)
- **What:** Assembles the final snapshot from all source events
- **Key logic:** `deduplicateEvents()` uses Jaccard similarity on tokenized titles + same-day + venue overlap, `completenessScore()` ranks events by data richness (coordinates, images, descriptions, ratings), outputs `BuiltSnapshot` with `mergedEvents`, `dedupeGroups`, and per-source `sourceResults`

---

## 6. Supabase Tables

| Table | Purpose | Writer | Reader |
|-------|---------|--------|--------|
| `external_event_snapshots` | Pre-warmed event snapshots per metro+intent | Worker | iOS app, Ingestion API |
| `external_event_viewport_tiles` | Precomputed z/x/y tile bundles for map reads | Worker | iOS app |
| `ingestion_metros` | Metro definitions with tier and refresh intervals | Admin | Trigger, Worker |
| `refresh_jobs` | Job queue (pending/claimed/completed/failed) | Trigger | Worker |
| `refresh_runs` | Execution history per job | Worker | Ingestion API |
| `venue_review_cache` | Google review cache with poison protection | Worker (reviews helper) | Worker, Debug API |
| `source_health` | Per-source success/failure/latency per window | Worker | Ingestion API |
| `coverage_metrics` | Metro-level event/review/nightlife coverage | Worker | Ingestion API |
| `poi_viewport_tiles` | POI tile placeholders | Trigger (POI refresh) | iOS app |
| `player_profiles` | User game profiles | iOS app | iOS app |

---

## 7. Environment Variables

### Required

| Variable | Used by |
|----------|---------|
| `SUPABASE_URL` | SupabaseModule |
| `SUPABASE_SERVICE_ROLE_KEY` | SupabaseModule |
| `TICKETMASTER_API_KEY` | TicketmasterHelper |

### Optional (with defaults)

| Variable | Default | Used by |
|----------|---------|---------|
| `PORT` | `4800` | main.ts |
| `WORKER_ID` | `worker-<pid>-<timestamp>` | WorkerService |
| `POLL_INTERVAL_MS` | `8000` | WorkerService |
| `HEARTBEAT_INTERVAL_MS` | `30000` | WorkerService |
| `MAX_CONCURRENT_JOBS` | `5` | WorkerService |
| `HEARTBEAT_TIMEOUT_MINUTES` | `5` | WorkerService |
| `EVENTBRITE_PRIVATE_TOKEN` | — | Not currently used by any helper |

---

## 8. Middleware & Security

### Rate Limiting (`@nestjs/throttler`)

Applied globally via `ThrottlerGuard` with three tiers — a request must pass all three:

| Tier | Window | Max Requests | Purpose |
|------|--------|-------------|---------|
| `short` | 1s | 3 | Burst protection |
| `medium` | 10s | 20 | Sustained abuse prevention |
| `long` | 60s | 100 | Overall throughput cap |

The `WorkerController` is decorated with `@SkipThrottle()` since it's an internal endpoint.

### Helmet

Applied in `main.ts` via `app.use(helmet())` — sets security headers (X-Content-Type-Options, X-Frame-Options, etc.).

### CORS

Enabled globally via `app.enableCors()`.

### Validation

Global `ValidationPipe` with `whitelist: true` strips unknown properties from request bodies, `transform: true` auto-converts types.

---

## 9. Logging

Uses `nestjs-pino` for structured JSON logging:

- **Production:** Raw JSON lines (parseable by Datadog, Loki, CloudWatch, etc.)
- **Development:** `pino-pretty` with colorized output
- **Log level:** `info`
- **HTTP auto-logging:** Disabled (only explicit logs)

Services use `@InjectPinoLogger()` with structured objects:

```typescript
this.logger.info({
  msg: 'job_processed',
  metro: metro.display_name,
  intent,
  eventCount: 42,
  durationMs: 1234,
});
```

---

## 10. Viewport Tile Materialization

After building a snapshot, the worker materializes it into viewport tiles for the iOS map view:

1. Compute base tiles around the metro center (`tilesForMetro` at zoom 11)
2. Add event halo tiles (tiles containing events + neighbors)
3. Sort by distance from center, cap at max (225 for high-density, 144 for normal)
4. For each tile: filter events within tile bounds, build tile snapshot, upsert to `external_event_viewport_tiles`
5. Run with concurrency limit of 8

High-density metros (LA, NYC, Miami, Chicago, etc.) get larger padding (4 vs 3) and more tiles (225 vs 144).

---

## 11. Complete API Reference

### Trigger Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/trigger-refresh` | Enqueue one metro + intent |
| POST | `/api/trigger-backfill` | Enqueue all metros up to tier N |
| POST | `/api/trigger-metro-refresh` | Enqueue all intents for one metro |
| POST | `/api/trigger-tile-scrape` | Enqueue metros near a tile |
| POST | `/api/trigger-metro-batch` | Enqueue only stale intents for a metro |
| POST | `/api/trigger-on-demand-tile` | On-demand tile refresh |
| POST | `/api/trigger-poi-refresh` | Seed POI tiles for a metro |

### Ingestion Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ingestion/status` | Job queue counts, recent run stats |
| GET | `/api/ingestion/source-health` | Per-source success/failure/latency |

### Debug Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/debug/test-review` | Test Google review scraping for a venue |
| GET | `/api/debug/check-venue-rating` | Check cached + snapshot rating for a venue |
| GET | `/api/debug/raw-event` | Find raw event data by venue name |
| GET | `/api/debug/venue-cache-lookup` | Lookup venue review cache by computed key |
| POST | `/api/debug/clear-review-cache` | Clear all cached reviews |
| POST | `/api/debug/clear-poisoned-reviews` | Clear poisoned + low-rating reviews |
| POST | `/api/debug/scrape-and-cache` | Scrape a venue and write to cache |

### Worker Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/worker/start` | Start the ingestion poll loop |
| DELETE | `/api/worker/stop` | Gracefully stop the worker |
| GET | `/api/worker/status` | Worker uptime, job counts |

---

## 12. What Was Ported from `backend/`

Every file from the original Hono backend was ported:

| Original file | NestJS equivalent |
|---------------|-------------------|
| `backend/worker/adapters/ticketmaster.ts` | `helpers/ticketmaster.helper.ts` |
| `backend/worker/adapters/eventbrite.ts` | `helpers/eventbrite.helper.ts` |
| `backend/worker/adapters/google-events.ts` | `helpers/google-events.helper.ts` |
| `backend/worker/adapters/runsignup.ts` | `helpers/runsignup.helper.ts` |
| `backend/worker/adapters/nightlife-enrichment.ts` | `helpers/nightlife-enrichment.helper.ts` |
| `backend/worker/adapters/google-reviews.ts` | `helpers/google-reviews.helper.ts` |
| `backend/worker/lib/snapshot-builder.ts` | `helpers/snapshot-builder.helper.ts` |
| `backend/worker/lib/normalize.ts` | `helpers/normalize.helper.ts` |
| `backend/worker/lib/tile-math.ts` | `helpers/tile-math.helper.ts` |
| `backend/worker/lib/config.ts` | `config/configuration.ts` + `config/env.validation.ts` |
| `backend/worker/ingestion-worker.ts` | `routes/worker/worker.service.ts` |
| `backend/routes/*` | `routes/trigger/`, `routes/ingestion/`, `routes/debug/` |

Key architectural decisions during the port:
- **No `adapters/` folder** — adapter logic lives in `helpers/` as `@Injectable()` services
- **No API key runtime checks** — Zod validates at startup, so helpers use `!` non-null assertions
- **Supabase injected as class token** — `private readonly supabase: SupabaseClient` (no `@Inject('SUPABASE_CLIENT')`)
- **Worker uses RPCs** — `heartbeat_refresh_job`, `complete_refresh_job`, `fail_refresh_job`, `reclaim_stale_jobs` instead of raw table queries
