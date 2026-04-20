export interface MetroRecord {
  id: string;
  slug: string;
  display_name: string;
  city?: string;
  state?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
  postal_code?: string | null;
  tier?: number;
  refresh_interval_minutes?: number;
  enabled?: boolean;
}

export interface RefreshJob {
  id: string;
  metro_id: string;
  intent: string;
  priority: number;
  status: string;
  claimed_by: string | null;
  retry_count: number;
  max_retries: number;
}

export interface TileCoordinate {
  z: number;
  x: number;
  y: number;
}

export interface TileBounds {
  northLatitude: number;
  southLatitude: number;
  eastLongitude: number;
  westLongitude: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface EnqueueResult {
  inserted: number;
  skipped: number;
  jobs: any[];
}

export interface JobQueueEntry {
  metro_id: string;
  intent: string;
  priority: number;
}

export interface VenueReviewResult {
  rating: number | null;
  reviewCount: number | null;
  url: string;
  source: string;
}

export interface IngestionStatusResponse {
  jobs: Record<string, number>;
  recent_runs: {
    count: number;
    avg_duration_ms: number;
    total_events: number;
  };
  metros: number;
}

export interface SourceHealthEntry {
  total_requests: number;
  total_successes: number;
  total_failures: number;
  total_timeouts: number;
  total_events: number;
  avg_latency_ms: number;
  success_rate: string;
  windows: number;
}

export interface SourceHealthResponse {
  sources: Record<string, SourceHealthEntry>;
}

export interface VenueCacheEntry {
  venue_key: string;
  venue_name: string;
  google_rating: number | null;
  google_review_count: number | null;
  google_maps_url: string | null;
  is_poisoned: boolean;
  poison_reason: string | null;
  fetched_at: string;
}

export interface SnapshotEventMatch {
  title: string;
  venueName: string;
  venueRating: number | null;
  cacheKey: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

export interface ReviewSignal {
  rating: number;
  reviewCount: number | null;
  url: string;
  source: 'scraped_google_maps';
}

export interface RefreshRunRow {
  status: string;
  duration_ms?: number;
  event_count?: number;
  review_hit_count?: number;
  review_miss_count?: number;
}

export interface JobStatusRow {
  status: string;
}

export interface SourceHealthRow {
  source: string;
  request_count: number;
  success_count: number;
  failure_count: number;
  timeout_count: number;
  event_count: number;
  avg_latency_ms: number;
}

export interface SnapshotRow {
  cache_key: string;
  snapshot: any;
}

export interface ReviewLookup {
  cacheKey: string;
  venueName: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  query: string;
  reviewURLs: string[];
}

// ─── Adapter Types ────────────────────────────────────────────────────

export interface EventResult {
  id: string;
  source: string;
  sourceEventId: string;
  sourceParentId?: string;
  sourceUrl?: string;
  title: string;
  shortDescription?: string;
  fullDescription?: string;
  category?: string;
  subcategory?: string;
  eventType: string;
  startAtUTC?: string;
  endAtUTC?: string;
  startLocal?: string;
  endLocal?: string;
  timezone?: string;
  venueName?: string;
  venueId?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  imageUrl?: string;
  status?: string;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  ticketUrl?: string;
  tags?: string[];
  rawSourcePayload?: Record<string, unknown>;
}

export interface AdapterResult {
  source: string;
  events: EventResult[];
  requestCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  avgLatencyMs: number;
  notes: string[];
}

// ─── Nightlife Types ──────────────────────────────────────────────────

export interface NightlifeVenue {
  id: string;
  source: 'discotech' | 'clubbable' | 'hwood';
  name: string;
  city?: string;
  state?: string;
  postalCode?: string;
  addressLine1?: string;
  latitude?: number;
  longitude?: number;
  imageURL?: string;
  galleryImages: string[];
  reservationURL?: string;
  reservationProvider?: string;
  openingHoursText?: string;
  ageMinimum?: number;
  doorPolicyText?: string;
  dressCodeText?: string;
  guestListAvailable: boolean;
  bottleServiceAvailable: boolean;
  tableMinPrice?: number;
  coverPrice?: number;
  entryPolicySummary?: string;
  womenEntryPolicyText?: string;
  menEntryPolicyText?: string;
  exclusivityTierLabel?: string;
  nightlifeSignalScore: number;
  prestigeDemandScore: number;
  sourceConfidence: number;
  rawPayload: Record<string, unknown>;
}

export interface MarketDiscoveryResult {
  source: 'discotech' | 'clubbable' | 'hwood';
  venues: NightlifeVenue[];
  requestCount: number;
  successCount: number;
  failureCount: number;
  notes: string[];
}

// ─── Snapshot Types ───────────────────────────────────────────────────

export interface BuiltSnapshot {
  fetchedAt: string;
  searchLocation: {
    city: string;
    state: string;
    postalCode: string | null;
    countryCode: string;
    latitude: number;
    longitude: number;
    displayName: string;
  };
  appliedProfiles: Array<{
    step: number;
    hyperlocalRadiusMiles: number;
    nightlifeRadiusMiles: number;
    headlineRadiusMiles: number;
  }>;
  venueSnapshot: null;
  eventSnapshot: {
    fetchedAt: string;
    query: {
      countryCode: string;
      city: string;
      state: string;
      postalCode: string | null;
      latitude: number;
      longitude: number;
      radiusMiles: number;
      pageSize: number;
      page: number;
      sourcePageDepth: number;
      includePast: boolean;
      hyperlocalRadiusMiles: number;
      nightlifeRadiusMiles: number;
      headlineRadiusMiles: number;
      adaptiveRadiusExpansion: boolean;
      discoveryIntent: string;
    };
    sourceResults: Array<{
      source: string;
      usedCache: boolean;
      fetchedAt: string;
      endpoints: Array<{
        label: string;
        requestURL: string;
        responseStatusCode: number | null;
        worked: boolean;
        note: string | null;
      }>;
      note: string | null;
      nextCursor: null;
      events: SnapshotEvent[];
    }>;
    mergedEvents: SnapshotEvent[];
    dedupeGroups: Array<{
      dedupeKey: string;
      canonicalEventID: string;
      mergedEventIDs: string[];
      mergedSources: string[];
      reason: string;
    }>;
  };
  mergedEvents: SnapshotEvent[];
  notes: string[];
}

export interface SnapshotEvent {
  id: string;
  source: string;
  sourceEventID: string;
  sourceParentID?: string;
  sourceURL?: string;
  mergedSources: string[];
  title: string;
  shortDescription?: string;
  fullDescription?: string;
  category?: string;
  subcategory?: string;
  eventType: string;
  startAtUTC?: string;
  endAtUTC?: string;
  startLocal?: string;
  endLocal?: string;
  timezone?: string;
  salesStartAtUTC?: string;
  salesEndAtUTC?: string;
  venueName?: string;
  venueID?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  imageURL?: string;
  fallbackThumbnailAsset?: string;
  status: string;
  availabilityStatus: string;
  urgencyBadge?: string;
  socialProofCount?: number;
  socialProofLabel?: string;
  venuePopularityCount?: number;
  venueRating?: number;
  ticketProviderCount?: number;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  organizerName?: string;
  organizerEventCount?: number;
  organizerVerified?: boolean;
  tags: string[];
  distanceValue?: number;
  distanceUnit?: string;
  raceType?: string;
  registrationURL?: string;
  ticketURL?: string;
  rawSourcePayload: string;
  sourceType: string;
  recordKind: string;
  neighborhood?: string;
  reservationURL?: string;
  artistsOrTeams: string[];
  ageMinimum?: number;
  doorPolicyText?: string;
  dressCodeText?: string;
  guestListAvailable?: boolean;
  bottleServiceAvailable?: boolean;
  tableMinPrice?: number;
  coverPrice?: number;
  openingHoursText?: string;
  sourceConfidence?: number;
  popularityScoreRaw?: number;
  venueSignalScore?: number;
  exclusivityScore?: number;
  trendingScore?: number;
  crossSourceConfirmationScore?: number;
  distanceFromUser?: number;
  entryPolicySummary?: string;
  womenEntryPolicyText?: string;
  menEntryPolicyText?: string;
  exclusivityTierLabel?: string;
}

// ─── Worker Types ─────────────────────────────────────────────────────

export interface WorkerConfig {
  workerId: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  maxConcurrentJobs: number;
  heartbeatTimeoutMinutes: number;
  ticketmasterApiKey?: string;
  eventbriteToken?: string;
}

// ─── Ticketmaster Internal Types ──────────────────────────────────────

export interface TmEvent {
  id: string;
  name: string;
  type?: string;
  url?: string;
  dates?: {
    start?: { localDate?: string; localTime?: string; dateTime?: string };
    end?: { localDate?: string; localTime?: string; dateTime?: string };
    timezone?: string;
    status?: { code?: string };
  };
  classifications?: Array<{
    segment?: { name?: string };
    genre?: { name?: string };
    subGenre?: { name?: string };
  }>;
  _embedded?: {
    venues?: Array<{
      id?: string;
      name?: string;
      address?: { line1?: string };
      city?: { name?: string };
      state?: { stateCode?: string };
      postalCode?: string;
      country?: { countryCode?: string };
      location?: { latitude?: string; longitude?: string };
      timezone?: string;
    }>;
  };
  images?: Array<{ url?: string; width?: number; ratio?: string }>;
  priceRanges?: Array<{ min?: number; max?: number; currency?: string }>;
  info?: string;
  pleaseNote?: string;
}

// ─── Eventbrite Internal Types ────────────────────────────────────────

export interface EventbriteListPayload {
  itemListElement?: Array<{
    item?: EventbriteItem;
  }>;
}

export interface EventbriteItem {
  name?: string;
  description?: string;
  url?: string;
  image?: string;
  startDate?: string;
  endDate?: string;
  location?: {
    name?: string;
    address?: {
      streetAddress?: string;
      addressLocality?: string;
      addressRegion?: string;
      postalCode?: string;
      addressCountry?: string;
    };
    geo?: {
      latitude?: string;
      longitude?: string;
    };
  };
}

export interface EventbriteChannel {
  label: string;
  path: string;
  fallbackType: string;
}

// ─── Google Events Internal Types ─────────────────────────────────────

export interface SearchChannel {
  label: string;
  queryText: string;
  fallbackType: string;
}

export interface ParsedGoogleCard {
  docId: string | undefined;
  title: string;
  when: string | undefined;
  day: string | undefined;
  month: string | undefined;
  venueName: string | undefined;
  address: string | undefined;
  ticketUrls: string[];
  imageUrl: string | undefined;
  venueRating: number | undefined;
  venueReviewCount: number | undefined;
}

// ─── RunSignup Internal Types ─────────────────────────────────────────

export interface RunSignupListResponse {
  races?: Array<{
    race?: {
      race_id?: number;
      name?: string;
      description?: string;
      next_date?: string;
      url?: string;
      address?: {
        city?: string;
        state?: string;
        zipcode?: string;
      };
    };
  }>;
}

export interface RunSignupDetailResponse {
  race?: {
    race_id?: number;
    name?: string;
    description?: string;
    url?: string;
    timezone?: string;
    logo_url?: string;
    is_registration_open?: string;
    next_date?: string;
    address?: {
      street?: string;
      street2?: string;
      city?: string;
      state?: string;
      zipcode?: string;
      country_code?: string;
    };
    events?: Array<{
      event_id?: number;
      name?: string;
      details?: string | null;
      start_time?: string;
      end_time?: string;
      event_type?: string;
      distance?: string;
      registration_periods?: Array<{
        race_fee?: string;
      }>;
    }>;
  };
}
