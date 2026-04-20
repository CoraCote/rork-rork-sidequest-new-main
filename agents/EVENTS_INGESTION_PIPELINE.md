# Unified Events Ingestion Pipeline — Architecture Reference

This document covers the cross-source events ingestion pipeline that lives in `server/src/` and its iOS consumer in `ios/SideQuest/`. It is separate from the older snapshot/tile feed (see `SERVER_INFRASTRUCTURE.md`) and represents the pipeline that writes into the normalized `events` table and serves the Leaflet/OSM-based map in the app.

---

## 1. Why It Exists

The legacy pipeline wrote per-source blobs into `external_event_viewport_tiles` + snapshot caches. That worked for a single surface but made cross-source dedup, source-priority backfill, and generic viewport queries expensive.

This pipeline replaces that for the map-explore surface with:

- One canonical `events` table, one row per distinct real-world event.
- A normalization layer that takes each source's native payload and produces a `NormalizedEvent` with the same fields.
- A merge pass that collapses the same event observed across multiple sources by a deterministic `dedup_hash`, keeping the winner by source priority and back-filling missing fields from losers.
- A single viewport endpoint that the iOS map calls with a lat/lng bbox + zoom; the server decides whether to return points or aggregated clusters.
- A Leaflet + OSM tiles WKWebView map on iOS (no MapKit) with a Snap-style dark filter.

---

## 2. Data Model

SQL lives in `server/sql/`:

- `001_events.sql` — the `events` table. One row per source event. Key columns:
  - `source` / `source_event_id` — natural key, `UNIQUE(source, source_event_id)`
  - `dedup_hash` — deterministic across sources, used for merge
  - `merged_into uuid` — points losers at the winner; viewport queries filter `merged_into IS NULL`
  - `merged_sources text[]` — list of source labels rolled into this winner
  - `latitude / longitude / geohash` — geocoded, used for viewport + bucket clustering
  - `start_at_utc / start_local / timezone` — canonical timing
  - Display fields: `title`, `short_description`, `full_description`, `image_url`, `venue_name`, `category`, `subcategory`, `price_min/max`, `currency`, `ticket_url`, `reservation_url`, `registration_url`, `source_url`
- `002_geocode_cache.sql` — `geocode_cache` table used by `OsmHelper`. Keyed by `query_hash` (sha256 of normalized query text). Stores full Nominatim response in `raw jsonb` plus indexed lat/lng, address parts, `hit_count`, `last_used_at`.

Source priority (higher wins during merge) is defined in `events-repository.helper.ts`:

```
ticketmaster: 100
eventbrite:   90
discotech:    80
clubbable:    60
runsignup:    50
```

---

## 3. Server Code

```
server/src/
  helpers/
    event-normalizer.helper.ts     # Per-source → NormalizedEvent, dedup_hash + geohash
    events-repository.helper.ts    # upsertAndMerge, queryViewport, mergeHashes
    osm.helper.ts                  # Nominatim geocoder (memory + Supabase cache)
    ticketmaster.helper.ts         # existing
    eventbrite.helper.ts           # existing
    runsignup.helper.ts            # existing
    discotech.helper.ts            # existing
    clubbable.helper.ts            # existing
  routes/
    events/
      events.controller.ts         # POST /events/ingest/la, GET/POST /events/viewport
      events.service.ts            # Fan-out LA ingestion, queryViewport wrapper
      events.module.ts
  dtos/events/
    viewport.dto.ts                # ViewportQueryDto (minLat/maxLat/minLng/maxLng/zoom/...)
```

### `event-normalizer.helper.ts`
- Exports `NormalizedEvent`, `EventSource`, `EventTypeSlug`, `EventRecordKind`.
- One `fromX(...)` method per source that returns `NormalizedEvent | null`.
- Central `build(partial)` method fills every field with `?? null` / `?? []` defaults, then computes `geohash` (from `EventDedupHelper.geohash`) and `dedup_hash` (`normalizedDedupKey`) at the end.
- `parseAge(ages?: string | number | null)` — accepts both string (Eventbrite-style) and number (Discotech-style) to avoid `.match is not a function` crashes.

### `events-repository.helper.ts`
- `upsertAndMerge(events)` — upserts in batches of 100 on `(source, source_event_id)`, then runs a cross-source merge pass.
- `mergeHashes(hashes)` — selects un-merged rows with `dedup_hash IN (...)`, groups by hash, picks winner by source priority, writes `merged_into` on losers and back-fills missing winner fields from losers via `fillMissing`.
- **Important**: `.in('dedup_hash', ...)` batch size is **25**. PostgREST passes `.in()` values via the URL query string, and larger batches overflow the 16KB header limit (`HeadersOverflowError`). Do not raise this without moving to an RPC.
- `queryViewport({ minLat, maxLat, minLng, maxLng, zoom, startAfterUTC?, limit? })` — filters `merged_into IS NULL` and bbox. If `zoom >= 12` returns `{ mode: 'points', points }`; otherwise buckets points into a geohash-like grid (`naiveBucketKey`) and returns `{ mode: 'clusters', clusters }`.

### `osm.helper.ts`
- Nominatim client: `https://nominatim.openstreetmap.org/search?format=jsonv2&...&namedetails=1&entrances=1&addressdetails=1`.
- User-Agent required (`SideQuest/1.0 (events-ingestion)`).
- Throttle: `minRequestSpacingMs = 1100` — respects the 1 req/sec public rate limit with ~10% margin.
- Three-tier cache: in-process `Map` → Supabase `geocode_cache` → HTTP. Negative results (null lat/lng) are cached so failed lookups aren't retried. `touchCache` bumps `last_used_at` for observability (RPC `geocode_cache_touch` with direct-update fallback).
- `getRequestCount()` / `getCacheHitCount()` are exposed so ingestion summaries can report cache effectiveness.

### `events.service.ts`
- `ingestLosAngeles()` runs all five source ingesters in `Promise.allSettled`:
  1. `ingestTicketmasterLA` — `searchAllEvents({ latlong, radius: 30, unit: 'miles' })`
  2. `ingestEventbriteLA` — currently calls `fetchUnitedStatesEventsDetailed()` (page 1, country-wide sample — known gap, needs a city-scoped fetch to actually hit LA)
  3. `ingestRunSignupLA` — `searchRacesWithDetails({ city: 'Los Angeles', state: 'CA', radius: 30 })`, geocodes each race via `OsmHelper.geocodeAddress`, falls back to LA centroid on miss
  4. `ingestDiscotechLA` — `fetchVenuesWithEvents()` filtered to LA by city name or bbox; emits both a venue row and each event row
  5. `ingestClubbableLA` — `fetchCityWithClubs('Los-Angeles')`, emits one row per club
- Every row is filtered through `inLaBbox` before upsert.
- LA bbox: `minLat=33.7, maxLat=34.34, minLng=-118.67, maxLng=-118.15`. Centroid: `34.0522, -118.2437`.
- Summary includes per-source `{ fetched, normalized, inserted, merged, skipped }` plus `nominatimRequests` / `nominatimCacheHits`.

### `events.controller.ts`
- `POST /events/ingest/la` → `ingestLosAngeles()` (manual trigger / cron)
- `GET /events/viewport?minLat=...&maxLat=...&minLng=...&maxLng=...&zoom=...` → `queryViewport`
- Same endpoint also accepts `POST` with JSON body.

---

## 4. iOS Consumer

```
ios/SideQuest/
  Models/MapEvent.swift            # MapEvent, MapCluster, ViewportResponse (Codable)
  Services/EventsViewportService.swift
                                    # @MainActor singleton, debounced viewport fetcher
  Views/OSMEventsMapView.swift     # UIViewRepresentable wrapping WKWebView + Leaflet
```

### `EventsViewportService`
- Reads `SERVER_BASE_URL` from the config bundle, defaults to `https://sidequest-ingestion-worker.fly.dev`.
- `fetchViewport(viewport, debounce:)` — cancels the in-flight task, waits ~350ms, then hits `/events/viewport`. Double-layered with a 250ms JS-side debounce on `moveend`/`zoomend`.
- Results delivered via `@MainActor` callbacks `onResult(ViewportResponse)` / `onError(Error)`.

### `OSMEventsMapView`
- `UIViewRepresentable` → `WKWebView` loading an inline HTML shell with Leaflet + OSM tiles.
- **No 3rd-party dark tile provider.** Dark Snap-style look is achieved with CSS `filter: invert(0.92) hue-rotate(180deg) ...` on `.leaflet-tile-pane`.
- Pins: thumbnail image with a category color ring (concert `#c56bff`, sports `#ffb020`, theatre `#f5c542`, race `#35d07a`, nightlife `#ff2d87`, festival `#ff7043`, other `#4aa3ff`). Emoji fallbacks (🎵 🏟️ 🎭 🏃 🍸 🎪 ✨). Price chip overlay.
- Clusters: gradient pulse circles with `@keyframes`, three size buckets (sm/md/lg), `99+` cap.
- Interactions: cluster tap → `map.flyTo`; pin tap → `map.panTo` + custom bottom sheet slides up (spring easing). Recenter button top-right.
- JS → Swift bridge via `webkit.messageHandlers`:
  - `viewportChanged` — payload `{ minLat, maxLat, minLng, maxLng, zoom }`
  - `markerTapped` — payload `{ id }`
- Coordinator implements `WKScriptMessageHandler`, debounces viewport messages through `EventsViewportService`, and re-posts pin/cluster JSON back into the web view via `evaluateJavaScript`.

---

## 5. Operational Notes

- **Rate limits**: Nominatim is the only external call with a strict public limit (1 req/sec). `OsmHelper` handles this with an 1100ms spacing. Violating this can get the IP temporarily blocked — never remove the throttle.
- **Cache warmth**: a typical LA ingestion run after the first should show `nominatimRequests: 0` and `nominatimCacheHits` roughly equal to the number of RunSignup races geocoded. If `nominatimRequests` grows, check whether race addresses are changing or whether the hash normalization broke.
- **Merge batch size**: `mergeBatch = 25` in `upsertAndMerge`. Raising this re-introduces the `HeadersOverflowError` from PostgREST. A proper fix is an RPC that accepts `hashes text[]` server-side.
- **Eventbrite LA coverage is a known gap.** `fetchUnitedStatesEventsDetailed()` pulls a 20-event country-wide sample; almost nothing lands in the LA bbox. A city-scoped fetch (Eventbrite destination listing for LA or an explicit location search) is the intended next step.
- **iOS build gotcha**: `ExerciseCameraService.jointAngle` uses `acos(...)` with `CGFloat` args — requires an explicit `Double` cast to avoid overload ambiguity. Unrelated to this pipeline but lives next to `EventsViewportService` in the same Swift compile group, so it blocks the whole build when broken.

---

## 6. How It Connects to the Older Feed

- The snapshot/tile pipeline (`external_event_viewport_tiles`, `poi_viewport_tiles`, `SupabaseEventViewportTileService`, `MapExploreView`) is still in place and documented in `SERVER_INFRASTRUCTURE.md`. It is not touched by this pipeline.
- The new `events` table and `/events/viewport` endpoint are the single source of truth for the OSM Leaflet map (`OSMEventsMapView`). Routing between the two iOS map surfaces is decided at the view layer, not in the server.
