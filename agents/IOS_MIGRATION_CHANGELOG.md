# iOS Supabase SDK Migration Changelog

## What Was Done
Migrated the iOS app from raw REST API calls (URLSession against PostgREST) to the official `supabase-swift` SDK, removed all legacy Expo references, and centralized configuration.

## Date: April 2026

---

## Changes Made

### 1. Added supabase-swift SDK via SPM
- **File:** `ios/SideQuest.xcodeproj/project.pbxproj`
- Added `supabase-swift` package (`https://github.com/supabase/supabase-swift`) v2.43.1
- Added XCRemoteSwiftPackageReference, XCSwiftPackageProductDependency, PBXBuildFile entries

### 2. Created centralized Supabase client
- **New file:** `ios/SideQuest/Services/SupabaseClient.swift`
- `SideQuestSupabase.client` — single shared `SupabaseClient` instance
- Reads URL and anon key from `Config.plist` via `Config.value(for:)`
- `SideQuestSupabase.isConfigured` helper for checking availability

### 3. Cleaned up Config.swift
- **File:** `ios/SideQuest/Services/Config.swift`
- Simplified to: Config.plist → environment variable fallback
- Removed all `EXPO_PUBLIC_` prefix logic (was leftover from React Native/Expo prototype)
- Added `Config.value(for:)` static helper used by all services

### 4. Created Config.plist system
- **New file:** `ios/SideQuest/Config.plist` (gitignored — contains real credentials)
- **New file:** `ios/SideQuest/Config.plist.example` (committed — template with placeholders)
- **Modified:** `.gitignore` — added `ios/SideQuest/Config.plist`
- Keys: SUPABASE_URL, SUPABASE_ANON_KEY, SERVER_BASE_URL, TICKETMASTER_API_KEY, TICKETMASTER_API_SECRET, TICKETMASTER_API_KEYS, EVENTBRITE_PRIVATE_TOKEN, APIFY_CLIENT_ID, APIFY_API_TOKEN

### 5. Migrated SupabaseProfileService.swift
- **Before:** Raw URLSession calls to `/rest/v1/player_profiles` with manual headers
- **After:** SDK calls: `.from("player_profiles").upsert()`, `.select().eq().limit().execute().value`
- Removed manual URLSession, header management, JSONSerialization
- Kept `SupabasePlayerProfile` Codable struct and actor isolation

### 6. Migrated SupabaseEventFeedCacheService.swift
- **Before:** ~40-line `SupabaseEventFeedCacheConfiguration` struct, `SupabaseRuntimeSecretsStore` enum, manual `applyHeaders()`, `fetchRows()`, URL building
- **After:** SDK query methods: `fetchSnapshotRows()`, `fetchReviewRepairRows()`, `fetchNearbyBucketRows()`, `fetchFallbackRows()`
- Added `anyJSON(from:)` helper for `Any` → `AnyJSON` conversion (needed for RPC params)
- Added `parseJSONArray(from:)` helper for JSONB `snapshot` column → `[[String: Any]]`
- Save uses `.rpc("upsert_external_event_snapshot", params:).execute()`
- All ~900 lines of business logic (candidate ranking, review repair, sanitization) unchanged

### 7. Migrated SupabaseEventViewportTileService.swift
- **Before:** Manual URL building, `makeLoadRequest()`, `applyHeaders()`, `fetchRows()`
- **After:** `.from("external_event_viewport_tiles").select().eq().gte().lte().order().limit().execute()`
- All tile math logic preserved (tileRange, recommendedZoom, tileBounds)

### 8. Migrated SupabasePOIViewportTileService.swift
- **Before:** Raw URLSession calls
- **After:** SDK `.from("poi_viewport_tiles").select()` and `.upsert(body, onConflict:)`

### 9. Migrated CronSweepService.swift
- **Before:** Raw URLSession RPC calls + hardcoded Fly.io URL
- **After:** `SideQuestSupabase.client.rpc("enqueue_scheduled_refreshes").execute()`
- Server URL now configurable via `Config.value(for: "SERVER_BASE_URL")` with fallback

### 10. Updated FlyioScraperTriggerService.swift
- Changed `baseURL` from hardcoded to `Config.value(for: "SERVER_BASE_URL")` with fallback
- No Supabase SDK needed (only calls NestJS server endpoints)

### 11. Cleaned up ExternalEventIngestionService.swift
- Removed `resolveEnv()` method that prepended `EXPO_PUBLIC_` prefix
- `fromEnvironment()` now uses `Config.value(for:)` directly
- Removed `ExternalEventRuntimeSecretsStore` enum
- Moved hardcoded API keys from `sideQuestPrototype()` into Config.plist

### 12. Updated AppState.swift
- Changed `SupabaseEventFeedCacheService(configuration: .fromEnvironment())` to `SupabaseEventFeedCacheService.shared`

---

## What Was Removed
- All `EXPO_PUBLIC_` environment variable lookups
- `SupabaseEventFeedCacheConfiguration` struct
- `SupabaseRuntimeSecretsStore` enum
- `ExternalEventRuntimeSecretsStore` enum
- `resolveEnv()` method in ExternalEventIngestionService
- All `applyHeaders()` / `fetchRows()` / `makeXxxRequest()` methods in Supabase services
- All manual URLSession + PostgREST URL building for Supabase calls
- Hardcoded API keys from source code (moved to Config.plist)

## What Was Kept
- All business logic (tile math, event deduplication, candidate ranking, review repair, metro detection, sanitization)
- Actor-based concurrency on all services
- `SupabasePlayerProfile` and other Codable structs
- Event fallback chain: Supabase tiles → live API → device cache
- 16 hardcoded fallback US cities
- Offline UUID auth (no Supabase Auth)

## Build Verified
- `xcodebuild -project ios/SideQuest.xcodeproj -scheme SideQuest -sdk iphonesimulator build` compiles without errors
- supabase-swift v2.43.1 resolves and links correctly

## Known Issue Fixed During Migration
- `PostgrestTransformBuilder has no member 'neq'` — `.limit(1)` was called before `.neq()` in SupabaseProfileService, changing the builder type. Fixed by reordering: filters first, then `.limit()`.
