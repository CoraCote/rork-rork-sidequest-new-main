# SideQuest Backend

NestJS backend server for the SideQuest event discovery platform. Handles event ingestion from multiple sources, nightlife venue discovery, Google review enrichment, snapshot building, and viewport tile materialization.

## Architecture

```
src/
  config/            # App configuration and Zod env validation
  dtos/              # Request/response data transfer objects
  helpers/           # Injectable services for data fetching and processing
    ticketmaster     # Ticketmaster API client
    eventbrite       # Eventbrite event scraper
    google-events    # Google Events scraper
    runsignup        # RunSignup API client
    nightlife-enrichment  # Discotech, Clubbable, HWood venue discovery
    google-reviews   # Google review signal scraping and enrichment
    snapshot-builder # Event deduplication and snapshot assembly
    normalize        # Text normalization, dedup keys, review sanitization
    tile-math        # Viewport tile coordinate math
    geo              # Geo/distance utilities
  routes/
    trigger/         # POST /trigger — enqueue refresh jobs for metros
    ingestion/       # GET /ingestion — status, health, snapshots
    debug/           # GET /debug — review scraping test endpoints
    worker/          # POST /worker/start, DELETE /worker/stop, GET /worker/status
  utils/             # Shared types, enums, interfaces
  shared.module.ts   # Global providers (NormalizeHelper, GeoHelper)
  supabase.module.ts # Global SupabaseClient provider
```

## Setup

```bash
pnpm install
```

## Environment Variables

Create a `.env` file in the project root:

```env
# Supabase
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
SUPABASE_ANON_KEY=<your-anon-key>

# API Keys
TICKETMASTER_API_KEY=<your-key>
EVENTBRITE_PRIVATE_TOKEN=<your-token>
APIFY_API_TOKEN=<your-token>
YELP_API_KEY=<your-key>

# Worker (optional — defaults shown)
WORKER_ID=worker-<auto>
POLL_INTERVAL_MS=8000
HEARTBEAT_INTERVAL_MS=30000
MAX_CONCURRENT_JOBS=5
HEARTBEAT_TIMEOUT_MINUTES=5

# Server (optional)
PORT=3000
```

## Running

```bash
# development (watch mode)
pnpm run start:dev

# production
pnpm run build
pnpm run start:prod
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/trigger/enqueue` | Enqueue refresh jobs for one or more metros |
| POST | `/trigger/enqueue-all` | Enqueue refresh jobs for all enabled metros |
| GET | `/ingestion/status` | Job queue counts and recent run stats |
| GET | `/ingestion/health` | Per-source health metrics |
| GET | `/ingestion/snapshots` | List cached snapshots |
| GET | `/ingestion/snapshot/:cacheKey` | Get a specific snapshot |
| GET | `/ingestion/viewport-tiles` | List viewport tiles for an intent/region |
| GET | `/ingestion/viewport-tile/:tileKey` | Get a specific viewport tile |
| GET | `/ingestion/coverage` | Coverage metrics by metro |
| GET | `/ingestion/refresh-runs` | Recent refresh run history |
| POST | `/worker/start` | Start the ingestion worker poll loop |
| DELETE | `/worker/stop` | Gracefully stop the worker |
| GET | `/worker/status` | Worker uptime and job stats |
| GET | `/debug/scrape-venue` | Test Google review scraping for a venue |
| GET | `/debug/review-cache` | Inspect venue review cache entries |
