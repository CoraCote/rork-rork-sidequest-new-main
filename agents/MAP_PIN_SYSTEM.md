# Map Pin System — Architecture & Context

## Overview
The Explore map uses **MapLibre GL JS v4.7.1** running inside a `WKWebView` (not native MapKit). It renders a custom dark vector tile style with 3D buildings, and shows event markers as a combination of:
- **Circle layers** (dots/glow) — GPU-rendered, visible at all zoom levels
- **DOM-based HTML markers** — `maplibregl.Marker` elements with `<img>` tags for event photos

## Key Files

### iOS (Swift)
- **`ios/SideQuest/Views/Components/ExploreMapView.swift`** — The core map component
  - `UIViewRepresentable` wrapping a `WKWebView` that loads inline HTML with MapLibre
  - `Coordinator` class handles Swift↔JS communication via `WKScriptMessageHandler`
  - `syncMarkers()` sends encounter data as JSON to JS `window.S()` function
  - Category mapping: `jsCatKey(for:)` maps `ExternalEventType` → JS category keys, `jsCatKey(forPOI:)` maps `MapQuestCategory` → JS category keys
  - **No image processing in Swift** — image URLs are passed directly to JS, and `<img>` tags load them natively

- **`ios/SideQuest/Views/MapExploreView.swift`** — Parent view that manages data
  - `buildEncounterList()` — Now returns **only external API events** (no static POI/quest encounters)
  - `scheduleViewportDrivenEventLoad()` — Triggers server fetch when viewport changes
  - `filteredEncounterList` — Applies category filter chips (All/Live/Nightlife/Concerts/etc.)
  - Event merging: new viewport responses are merged with existing events still in viewport (not replaced)

- **`ios/SideQuest/Services/EventsViewportService.swift`** — Server API client
  - `Viewport` struct: `minLat, maxLat, minLng, maxLng` (no zoom)
  - Sends GET to `{baseURL}/events/viewport?minLat=...&maxLat=...&minLng=...&maxLng=...&limit=500`
  - Response cache with 2-min TTL, grid-rounded keys (precision 0.01°)
  - Debounced fetch (0.35s) to avoid rapid-fire requests

### Server (NestJS/TypeScript)
- **`server/src/helpers/events-repository.helper.ts`** — `queryViewport()`
  - Queries Supabase `events` table filtered by lat/lng bounds
  - Always returns `{ mode: 'points', points: [...] }` — no clustering
  - Zoom parameter removed — everything is purely viewport + lat/lng based

- **`server/src/dtos/events/viewport.dto.ts`** — `ViewportQueryDto`
  - Required: `minLat, maxLat, minLng, maxLng`
  - Optional: `zoom` (deprecated, ignored), `startAfterUTC`, `limit`

## Data Flow

```
User pans/zooms map
  → JS nvp() fires (160ms debounce)
  → JS sends viewport bounds to Swift via webkit.messageHandlers.viewportChanged
  → Swift Coordinator.onVP() → parent.onRegionChanged(viewport)
  → MapExploreView.handleRegionChanged() → scheduleViewportDrivenEventLoad()
  → EventsViewportService.requestViewport() → GET /events/viewport
  → Server queries Supabase by lat/lng bounds → returns points
  → Swift builds ExploreEncounters from ExternalEvents
  → SwiftUI updates → ExploreMapView.updateUIView() → syncMarkers()
  → JS window.S(json) → updates GeoJSON source + syncPins()
  → Circle layers render dots, DOM markers render photo pins
```

## JS Pin System (inside ExploreMapView.swift HTML)

### Layers (GPU-rendered, from GeoJSON source)
- `events-glow` — Soft ambient circle behind each event
- `events-dot` — Blue dot, opacity 0.85 at all zooms
- `events-label` — Title text, appears at zoom ≥ 14

### DOM Markers (HTML elements)
- Created by `syncPins()` when zoom ≥ 12.5
- Only for events with images (`m.img` must exist)
- Uses `maplibregl.Marker` with custom HTML: `.pin-wrap > .pin-circle > img + .pin-pointer`
- Images loaded natively via `<img src="...">` — no canvas, no base64, no addImage
- Markers removed when zooming out below 12.5 or when data changes

### Category Config
JS `CAT` object maps category keys to colors and emoji:
- `concert`, `sports_event`, `party_nightlife`, `race`, `festival`, `other_live_event`
- `park`, `gym`, `library`, `cafe`, `trail`, `museum`, `bookstore`, `yoga`, `pool`, `garden`

Swift maps are:
- `ExternalEventType` → JS keys via `jsCatKey(for:)` (e.g., `.concert` → `"concert"`)
- `MapQuestCategory` → JS keys via `jsCatKey(forPOI:)` (e.g., `.cafe`/`.restaurant` → `"cafe"`)

## Important Design Decisions

1. **No static/quest encounters on map** — Only external API events show. Quest encounters were removed from `buildEncounterList()`.

2. **No clustering** — Server always returns individual points. Client-side clustering was removed.

3. **No zoom parameter** — Viewport queries use only lat/lng bounds. Zoom was removed from `EventsViewportService.Viewport`, the server DTO, and the repository query.

4. **Event merging on viewport change** — When a new viewport response arrives, existing events still within the viewport are kept and merged with new events. This prevents events from disappearing during zoom transitions.

5. **DOM markers over symbol layers** — Previous attempts to use MapLibre's symbol layer with canvas-rendered pins or raw RGBA pixel data via `map.addImage()` failed in WKWebView. DOM markers with native `<img>` tags are reliable and work consistently.

6. **Uniform dot color** — All dots use `#448aff` (blue). No per-category coloring on the dot layer.

## Previous Approaches (Failed)
These approaches for image pins were attempted and did not work in WKWebView:
- Canvas → `getImageData` → `map.addImage()` with StyleImageInterface
- Swift `CGContext` → raw RGBA bytes → base64 → `callAsyncJavaScript` → `map.addImage()`
- PNG data URLs with `new Image()` → canvas → `map.addImage()`
- `map.loadImage()` with data URLs

The root issue was never definitively identified, but DOM markers bypass all of these problems entirely.
