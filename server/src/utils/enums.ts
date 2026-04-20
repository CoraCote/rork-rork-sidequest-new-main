export enum Intent {
  NEARBY_AND_WORTH_IT = 'nearby_and_worth_it',
  BIGGEST_TONIGHT = 'biggest_tonight',
  EXCLUSIVE_HOT = 'exclusive_hot',
  LAST_MINUTE_PLANS = 'last_minute_plans',
}

export const DEFAULT_INTENTS: Intent[] = [
  Intent.NEARBY_AND_WORTH_IT,
  Intent.BIGGEST_TONIGHT,
  Intent.EXCLUSIVE_HOT,
  Intent.LAST_MINUTE_PLANS,
];

export enum JobStatus {
  PENDING = 'pending',
  CLAIMED = 'claimed',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum SourceType {
  TICKETING_API = 'ticketing_api',
  SCRAPED = 'scraped',
  VENUE_DISCOVERY_API = 'venue_discovery_api',
}

export enum ReviewSource {
  GOOGLE_MAPS_API = 'google_maps_api',
  GOOGLE_MAPS_HTML = 'google_maps_html',
  GOOGLE_MAPS_JSON = 'google_maps_json',
  SCRAPED_GOOGLE_MAPS = 'scraped_google_maps',
}

export const POI_CATEGORIES = [
  'restaurant',
  'bar',
  'cafe',
  'nightlife',
  'fitness',
  'shopping',
  'entertainment',
  'arts',
  'outdoors',
  'hotel',
] as const;
