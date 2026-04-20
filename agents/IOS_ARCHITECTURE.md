# iOS App Architecture & Data Flow

## Overview
SideQuest is a native Swift/SwiftUI iOS app that shows nearby events and points of interest on a 3D map. It uses Supabase as its backend database, a NestJS server on Fly.io for event scraping, and Apple Maps for POI discovery.

## App Entry Point & Tab Structure

```
SideQuestApp.swift (@main)
  └── ContentView.swift
        ├── OnboardingView (if !hasOnboarded)
        └── mainTabView (5 tabs):
              Tab 0: QuickTabView      — "Quick" (bolt icon)
              Tab 1: QuestsTabView     — "Quests" (scroll icon)
              Tab 2: MapExploreView    — "Explore" (map icon) ← main map
              Tab 3: ProfileTabView    — "Profile" (person icon)
              Tab 4: DevModeView       — "Dev" (wrench icon) ← debug overlay
```

On appear, `ContentView` calls `appState.startExternalEventPipeline()` which kicks off event loading.

## Two Independent Map Data Layers

### Layer 1: POIs (Apple Maps) — Works with zero configuration
- **Service:** `MapPOIService.swift` → uses `MKLocalSearch` (Apple's built-in API, no API key needed)
- **Data:** Restaurants, gyms, parks, shops, etc. from Apple Maps database
- **Fallback coordinate:** `34.0900, -118.3617` (West Hollywood, LA) when no user location
- **Also uses:** `OverpassService.swift` for trails/bike paths (OpenStreetMap Overpass API)
- **State:** Stored in `MapExploreView.mixedPOIs: [MapPOI]`
- **This is what you see on the map when Supabase tables are empty**

### Layer 2: Events (Supabase + External APIs) — Requires backend scraping
- **Pipeline:** Backend scrapes → writes to Supabase → iOS reads from Supabase viewport tiles
- **Tables:** `external_event_viewport_tiles` (zoom level 11 only), `external_event_snapshots`
- **Sources:** Ticketmaster, Eventbrite, Google Events, RunSignUp, StubHub, Discotech
- **Shows under:** "Live", "Concerts", "Sports", "Nightlife" filter tabs
- **If Supabase tables are empty, this layer shows nothing**

## Event Data Flow (Full Pipeline)

```
1. iOS triggers backend scrape
   └── FlyioScraperTriggerService.swift
         POST /api/trigger-refresh, /api/trigger-on-demand-tile, /api/trigger-poi-refresh
         to: Config.value("SERVER_BASE_URL") ?? "https://sidequest-ingestion-worker.fly.dev"

2. Backend (NestJS on Fly.io) scrapes external APIs
   └── server/src/routes/trigger/trigger.controller.ts
         /trigger-refresh        — refresh a metro area
         /trigger-backfill       — backfill all metros
         /trigger-on-demand-tile — scrape specific tile (z, x, y, lat, lon)
         /trigger-metro-batch    — batch refresh a metro
         /trigger-poi-refresh    — refresh POI data

3. Backend writes scraped data to Supabase
   └── external_event_viewport_tiles table (materialized at zoom 11)
   └── external_event_snapshots table

4. iOS reads from Supabase
   └── SupabaseEventViewportTileService.swift — reads viewport tiles
   └── SupabaseEventFeedCacheService.swift — reads/writes event snapshots
   └── ExternalEventFeedService.swift — orchestrates feed loading

5. If Supabase has no data, iOS can also fetch directly from APIs
   └── ExternalEventIngestionService.swift — direct API calls as fallback
         Uses adapters: TicketmasterEventAdapter, EventbriteEventAdapter,
                       GoogleEventsEventAdapter, RunSignupEventAdapter
```

## Live API Fetching (Fallback when Supabase is empty)

`ExternalEventIngestionService.swift` can fetch events directly from APIs without going through the backend. It uses these adapters:
- `TicketmasterEventAdapter.swift` — Ticketmaster Discovery API
- `EventbriteEventAdapter.swift` — Eventbrite API
- `GoogleEventsEventAdapter.swift` — Via Apify actor
- `RunSignupEventAdapter.swift` — RunSignUp API
- `StubHubEventAdapter.swift` — Via Apify actor
- `SportsScheduleEventAdapter.swift` — TheSportsDB API

API keys come from `Config.plist` via `Config.value(for:)`.

## Hardcoded Fallback Locations

### Map POI fallback (MapPOIService.swift:24)
```swift
CLLocationCoordinate2D(latitude: 34.0900, longitude: -118.3617) // West Hollywood, LA
```

### Event search fallback (ExternalEventLocationService.swift)
Default postal code: `90069` (West Hollywood). Ultimate fallback: LA (`34.0522, -118.2437`).

### 16 preloaded US cities (ExternalEventLocationService.swift:20-174)
West Hollywood CA, New York NY, Miami Beach FL, Chicago IL, Austin TX, Dallas TX,
Nashville TN, Las Vegas NV, Atlanta GA, Charlotte NC, Houston TX, Seattle WA,
Phoenix AZ, Denver CO, Boston MA, Philadelphia PA, San Francisco CA

## Key Services

| Service | Purpose |
|---------|---------|
| `Config.swift` | Reads Config.plist → env var fallback |
| `SupabaseClient.swift` | Centralized `SupabaseClient` instance |
| `SupabaseProfileService.swift` | Player profiles CRUD |
| `SupabaseEventFeedCacheService.swift` | Event snapshot read/write + business logic |
| `SupabaseEventViewportTileService.swift` | Viewport tile loading + tile math |
| `SupabasePOIViewportTileService.swift` | POI viewport tiles |
| `CronSweepService.swift` | Scheduled refresh jobs via Supabase RPC |
| `FlyioScraperTriggerService.swift` | Triggers backend scrape endpoints |
| `ExternalEventIngestionService.swift` | Direct API fetching (fallback) |
| `MapPOIService.swift` | Apple Maps MKLocalSearch for POIs |
| `ExternalEventLocationService.swift` | Location resolution + fallback cities |
| `ExternalVenueDiscoveryService.swift` | Nightlife venue discovery (Discotech, Clubbable) |

## Authentication
- Uses offline UUID-based auth (no Supabase Auth)
- `AuthService.swift` manages local user identity
- Profile synced to Supabase `player_profiles` table

## Viewport Tile System
- Events are materialized at **zoom level 11 only** (`serverEventTileZoom = 11`)
- Tile math in `SupabaseEventViewportTileService.swift` (tileRange, longitudeToTileX, latitudeToTileY)
- Map region → tile range → query Supabase for matching tiles → decode events
- Debug overlay shows tile_range, loaded_intents, missing_intents
