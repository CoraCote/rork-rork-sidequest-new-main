import { Injectable } from '@nestjs/common';
import { EventDedupHelper, EventTypeSlug } from './event-dedup.helper';
import { TicketmasterEventFull } from './ticketmaster.helper';
import { ClubbableCity, ClubbableClub } from './clubbable.helper';
import { DiscotechEvent, DiscotechVenue } from './discotech.helper';

export type EventSource =
  | 'ticketmaster'
  | 'eventbrite'
  | 'runsignup'
  | 'clubbable'
  | 'discotech';

export type EventRecordKind = 'event' | 'venue' | 'recurring';

export interface NormalizedEvent {
  source: EventSource;
  source_event_id: string;
  source_parent_id: string | null;
  source_url: string | null;
  source_type: 'ticketing_api' | 'scraped' | 'manual';
  record_kind: EventRecordKind;

  title: string;
  short_description: string | null;
  full_description: string | null;
  category: string | null;
  subcategory: string | null;
  event_type: EventTypeSlug;

  start_at_utc: string | null;
  end_at_utc: string | null;
  start_local: string | null;
  end_local: string | null;
  timezone: string | null;
  sales_start_at_utc: string | null;
  sales_end_at_utc: string | null;

  venue_name: string | null;
  venue_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  neighborhood: string | null;
  latitude: number | null;
  longitude: number | null;
  geohash: string | null;

  image_url: string | null;
  status: string;
  availability_status: string | null;

  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  cover_price: number | null;
  table_min_price: number | null;

  venue_rating: number | null;
  venue_popularity_count: number | null;
  dress_code_text: string | null;
  guest_list_available: boolean | null;
  bottle_service_available: boolean | null;

  organizer_name: string | null;
  organizer_event_count: number | null;
  organizer_verified: boolean | null;

  race_type: string | null;
  distance_value: number | null;
  distance_unit: string | null;

  artists_or_teams: string[];
  registration_url: string | null;
  ticket_url: string | null;
  reservation_url: string | null;
  age_minimum: number | null;
  opening_hours_text: string | null;

  dedup_hash: string;
  tags: string[];
  raw_payload: Record<string, unknown>;
  source_updated_at: string | null;
}

@Injectable()
export class EventNormalizerHelper {
  constructor(private readonly dedup: EventDedupHelper) {}

  fromTicketmaster(event: TicketmasterEventFull): NormalizedEvent | null {
    if (!event.id || !event.name) return null;
    const venue = event._embedded?.venues?.[0];
    const classification = event.classifications?.[0];
    const lat = this.parseNumber(venue?.location?.latitude);
    const lng = this.parseNumber(venue?.location?.longitude);

    const eventType = this.classifyTicketmaster(classification);
    const startAt = event.dates?.start?.dateTime ?? null;
    const startLocal = event.dates?.start?.localDate
      ? `${event.dates.start.localDate}T${event.dates.start.localTime ?? '00:00:00'}`
      : null;
    const timezone = venue?.timezone ?? event.dates?.timezone ?? null;
    const price = event.priceRanges?.[0];
    const attractions = event._embedded?.attractions ?? [];

    return this.build({
      source: 'ticketmaster',
      source_event_id: event.id,
      source_parent_id: venue?.id ?? null,
      source_url: event.url ?? null,
      source_type: 'ticketing_api',
      record_kind: 'event',

      title: event.name,
      short_description: event.info?.slice(0, 200) ?? null,
      full_description: event.info ?? null,
      category: classification?.segment?.name ?? null,
      subcategory: classification?.genre?.name ?? null,
      event_type: eventType,

      start_at_utc: startAt,
      end_at_utc: event.dates?.end?.dateTime ?? null,
      start_local: startLocal,
      end_local: null,
      timezone,
      sales_start_at_utc: event.sales?.public?.startDateTime ?? null,
      sales_end_at_utc: event.sales?.public?.endDateTime ?? null,

      venue_name: venue?.name ?? null,
      venue_id: venue?.id ?? null,
      address_line1: venue?.address?.line1 ?? null,
      address_line2: venue?.address?.line2 ?? null,
      city: venue?.city?.name ?? null,
      state: venue?.state?.stateCode ?? venue?.state?.name ?? null,
      postal_code: venue?.postalCode ?? null,
      country: venue?.country?.countryCode ?? venue?.country?.name ?? null,
      latitude: lat,
      longitude: lng,

      image_url: this.pickBestImage(event.images) ?? null,
      status: this.mapTicketmasterStatus(event.dates?.status?.code),
      price_min: price?.min ?? null,
      price_max: price?.max ?? null,
      currency: price?.currency ?? null,

      artists_or_teams: attractions
        .map((a) => a.name)
        .filter((n): n is string => typeof n === 'string'),
      ticket_url: event.url ?? null,
      tags: [
        classification?.segment?.name,
        classification?.genre?.name,
        classification?.subGenre?.name,
      ].filter((t): t is string => Boolean(t)),
      raw_payload: event as unknown as Record<string, unknown>,
    });
  }

  fromEventbrite(event: EventbriteRawEvent): NormalizedEvent | null {
    if (!event.id || !event.name) return null;
    const venue = event.primary_venue;
    const organizer = event.primary_organizer;
    const lat = this.parseNumber(venue?.address?.latitude);
    const lng = this.parseNumber(venue?.address?.longitude);
    const startAtUTC = this.joinDate(
      event.start_date,
      event.start_time,
      event.timezone,
    );
    const endAtUTC = this.joinDate(
      event.end_date,
      event.end_time,
      event.timezone,
    );
    const availability = event.ticket_availability;
    const priceMin = availability?.minimum_ticket_price?.value;
    const priceMax = availability?.maximum_ticket_price?.value;
    const currency =
      availability?.minimum_ticket_price?.currency ??
      availability?.maximum_ticket_price?.currency ??
      null;

    return this.build({
      source: 'eventbrite',
      source_event_id: String(event.id),
      source_parent_id: organizer?.id ?? null,
      source_url: event.url ?? null,
      source_type: 'ticketing_api',
      record_kind: 'event',

      title: event.name,
      short_description: event.summary ?? null,
      full_description: event.summary ?? null,
      category:
        event.tags?.find((t) => t.prefix === 'EventbriteCategory')
          ?.display_name ?? null,
      subcategory:
        event.tags?.find((t) => t.prefix === 'EventbriteSubCategory')
          ?.display_name ?? null,
      event_type: 'other_live_event',

      start_at_utc: startAtUTC,
      end_at_utc: endAtUTC,
      start_local:
        event.start_date && event.start_time
          ? `${event.start_date}T${event.start_time}`
          : null,
      end_local:
        event.end_date && event.end_time
          ? `${event.end_date}T${event.end_time}`
          : null,
      timezone: event.timezone ?? null,
      sales_start_at_utc: null,
      sales_end_at_utc: null,

      venue_name: venue?.name ?? null,
      venue_id: venue?.id ?? null,
      address_line1: venue?.address?.address_1 ?? null,
      address_line2: venue?.address?.address_2 ?? null,
      city: venue?.address?.city ?? null,
      state: venue?.address?.region ?? null,
      postal_code: venue?.address?.postal_code ?? null,
      country: venue?.address?.country ?? null,
      latitude: lat,
      longitude: lng,

      image_url: event.image?.url ?? null,
      status: availability?.is_sold_out ? 'sold_out' : 'scheduled',
      availability_status: availability?.is_sold_out
        ? 'sold_out'
        : availability?.has_available_tickets
          ? 'available'
          : null,
      price_min: priceMin ?? null,
      price_max: priceMax ?? null,
      currency,

      organizer_name: organizer?.name ?? null,
      organizer_event_count: organizer?.num_upcoming_events ?? null,

      artists_or_teams: [],
      ticket_url: event.tickets_url ?? event.url ?? null,
      tags:
        event.tags
          ?.map((t) => t.display_name ?? t.tag)
          .filter((t): t is string => Boolean(t)) ?? [],
      raw_payload: event as unknown as Record<string, unknown>,
    });
  }

  fromRunSignup(
    race: RunSignupRaceInput,
    event: RunSignupEventInput,
    location: { latitude: number | null; longitude: number | null },
  ): NormalizedEvent | null {
    if (!race.race_id || !event.event_id || !event.name || !event.start_time) {
      return null;
    }
    const timezone = race.timezone ?? null;
    const startAtUTC = this.runsignupDateToUTC(event.start_time, timezone);
    const endAtUTC = event.end_time
      ? this.runsignupDateToUTC(event.end_time, timezone)
      : null;
    const priceMin = this.extractRunSignupPrice(event.registration_periods);
    const raceName = race.name ?? 'RunSignup Event';
    const address = race.address ?? {};
    const addressLine = [address.street, address.street2]
      .filter(Boolean)
      .join(', ');

    return this.build({
      source: 'runsignup',
      source_event_id: `${race.race_id}:${event.event_id}`,
      source_parent_id: String(race.race_id),
      source_url: race.url ?? null,
      source_type: 'ticketing_api',
      record_kind: 'event',

      title:
        event.name.toLowerCase() === raceName.toLowerCase()
          ? raceName
          : `${raceName} - ${event.name}`,
      short_description: this.stripHtml(
        event.details ?? race.description ?? null,
      ),
      full_description: this.stripHtml(
        event.details ?? race.description ?? null,
      ),
      category: 'fitness',
      subcategory: event.distance ?? event.event_type ?? null,
      event_type: 'race',

      start_at_utc: startAtUTC,
      end_at_utc: endAtUTC,
      start_local: event.start_time ?? null,
      end_local: event.end_time ?? null,
      timezone,
      sales_start_at_utc: null,
      sales_end_at_utc: null,

      venue_name: raceName,
      venue_id: String(race.race_id),
      address_line1: addressLine || null,
      city: address.city ?? null,
      state: address.state ?? null,
      postal_code: address.zipcode ?? null,
      country: address.country_code ?? 'US',
      latitude: location.latitude,
      longitude: location.longitude,

      image_url: race.logo_url ?? null,
      status: race.is_registration_open === 'T' ? 'onsale' : 'scheduled',
      price_min: priceMin,
      price_max: priceMin,
      currency: priceMin != null ? 'USD' : null,

      race_type: event.event_type ?? null,
      distance_value: this.parseDistance(event.distance).value,
      distance_unit: this.parseDistance(event.distance).unit,

      artists_or_teams: [],
      registration_url: race.url ?? null,
      ticket_url: race.url ?? null,
      tags: [event.distance, event.event_type].filter((v): v is string =>
        Boolean(v),
      ),
      raw_payload: {
        runsignup_race_id: race.race_id,
        runsignup_event_id: event.event_id,
        runsignup_distance: event.distance,
      },
    });
  }

  fromClubbable(
    city: ClubbableCity,
    club: ClubbableClub,
  ): NormalizedEvent | null {
    if (!club.name) return null;
    const openingHoursText = club.openingHours
      .map((h) => `${h.days.join('/')} ${h.opens}-${h.closes}`)
      .join('; ');

    return this.build({
      source: 'clubbable',
      source_event_id: `${city.slug}:${club.slug}`,
      source_parent_id: city.slug,
      source_url: club.url,
      source_type: 'scraped',
      record_kind: 'venue',

      title: club.name,
      short_description: club.description,
      full_description: club.description,
      category: 'nightlife',
      subcategory: 'club',
      event_type: 'nightlife',

      start_at_utc: null,
      end_at_utc: null,
      start_local: null,
      end_local: null,
      timezone: null,
      sales_start_at_utc: null,
      sales_end_at_utc: null,

      venue_name: club.name,
      venue_id: club.slug,
      address_line1: club.address || null,
      city: club.addressLocality ?? city.name,
      state: club.addressRegion,
      postal_code: club.postalCode,
      country: club.addressCountry,
      latitude: club.lat ?? null,
      longitude: club.lng ?? null,

      image_url: club.imageUrl,
      status: club.isOpen ? 'open' : 'scheduled',

      venue_rating: club.rating,
      venue_popularity_count: club.reviewCount,

      artists_or_teams: [],
      reservation_url: club.url,
      tags: [club.day, 'nightlife'].filter(Boolean),
      opening_hours_text: openingHoursText || null,
      raw_payload: club as unknown as Record<string, unknown>,
    });
  }

  fromDiscotechVenue(
    venue: DiscotechVenue,
    events: DiscotechEvent[] = [],
  ): NormalizedEvent | null {
    if (!venue.id || !venue.name) return null;
    return this.build({
      source: 'discotech',
      source_event_id: `venue:${venue.id}`,
      source_parent_id: venue.city?.slug ?? null,
      source_url: venue.url,
      source_type: 'ticketing_api',
      record_kind: 'venue',

      title: venue.name,
      short_description: venue.description_short ?? null,
      full_description: venue.description ?? null,
      category: 'nightlife',
      subcategory: venue.music ?? null,
      event_type: 'nightlife',

      start_at_utc: null,
      end_at_utc: null,
      start_local: null,
      end_local: null,
      timezone: venue.timezone ?? null,
      sales_start_at_utc: null,
      sales_end_at_utc: null,

      venue_name: venue.name,
      venue_id: String(venue.id),
      address_line1: venue.street_address ?? null,
      city: venue.city?.name ?? null,
      state: venue.city?.state ?? null,
      postal_code: venue.zip_code ?? null,
      country: venue.city?.country?.code ?? null,
      latitude: venue.lat ?? null,
      longitude: venue.lng ?? null,

      image_url:
        venue.hero_image_url ?? venue.flyer_image_url ?? venue.logo_url,
      status: 'scheduled',

      organizer_name: venue.hotel_name ?? null,
      artists_or_teams: [],
      reservation_url: venue.url ?? null,
      opening_hours_text: venue.hours ?? null,
      dress_code_text: venue.dress_code ?? null,
      tags: [venue.music, 'nightlife'].filter((v): v is string => Boolean(v)),
      raw_payload: { venue, upcoming_events_count: events.length } as Record<
        string,
        unknown
      >,
    });
  }

  fromDiscotechEvent(
    event: DiscotechEvent,
    venue: DiscotechVenue,
  ): NormalizedEvent | null {
    if (!event.id || !event.name) return null;
    return this.build({
      source: 'discotech',
      source_event_id: `event:${event.id}`,
      source_parent_id: String(venue.id),
      source_url: event.url,
      source_type: 'ticketing_api',
      record_kind: 'event',

      title: event.name,
      short_description: event.description?.slice(0, 200) ?? null,
      full_description: event.description ?? null,
      category: 'nightlife',
      subcategory: event.music || event.type || null,
      event_type: 'nightlife',

      start_at_utc: event.start_utc ?? null,
      end_at_utc: event.end_utc ?? null,
      start_local: event.start ?? null,
      end_local: event.end ?? null,
      timezone: venue.timezone ?? null,
      sales_start_at_utc: null,
      sales_end_at_utc: event.ticket_sales_end_utc ?? null,

      venue_name: venue.name,
      venue_id: String(venue.id),
      address_line1: venue.street_address ?? null,
      city: venue.city?.name ?? null,
      state: venue.city?.state ?? null,
      postal_code: venue.zip_code ?? null,
      country: venue.city?.country?.code ?? null,
      latitude: venue.lat ?? null,
      longitude: venue.lng ?? null,

      image_url: event.image_url ?? venue.hero_image_url ?? null,
      status: event.is_published ? 'scheduled' : 'offsale',

      guest_list_available: event.has_guest_list,
      bottle_service_available: event.has_table_reservations,

      artists_or_teams: [],
      ticket_url: event.external_ticket_url ?? event.url ?? null,
      reservation_url: venue.url ?? null,
      age_minimum: this.parseAge(event.ages),
      tags: [event.music, event.type, 'nightlife'].filter((v): v is string =>
        Boolean(v),
      ),
      raw_payload: event as unknown as Record<string, unknown>,
    });
  }

  private build(
    partial: Partial<NormalizedEvent> & {
      source: EventSource;
      source_event_id: string;
      source_type: NormalizedEvent['source_type'];
      record_kind: EventRecordKind;
      title: string;
      event_type: EventTypeSlug;
    },
  ): NormalizedEvent {
    const merged: NormalizedEvent = {
      source: partial.source,
      source_event_id: partial.source_event_id,
      source_parent_id: partial.source_parent_id ?? null,
      source_url: partial.source_url ?? null,
      source_type: partial.source_type,
      record_kind: partial.record_kind,
      title: partial.title,
      short_description: partial.short_description ?? null,
      full_description: partial.full_description ?? null,
      category: partial.category ?? null,
      subcategory: partial.subcategory ?? null,
      event_type: partial.event_type,
      start_at_utc: partial.start_at_utc ?? null,
      end_at_utc: partial.end_at_utc ?? null,
      start_local: partial.start_local ?? null,
      end_local: partial.end_local ?? null,
      timezone: partial.timezone ?? null,
      sales_start_at_utc: partial.sales_start_at_utc ?? null,
      sales_end_at_utc: partial.sales_end_at_utc ?? null,
      venue_name: partial.venue_name ?? null,
      venue_id: partial.venue_id ?? null,
      address_line1: partial.address_line1 ?? null,
      address_line2: partial.address_line2 ?? null,
      city: partial.city ?? null,
      state: partial.state ?? null,
      postal_code: partial.postal_code ?? null,
      country: partial.country ?? null,
      neighborhood: partial.neighborhood ?? null,
      latitude: partial.latitude ?? null,
      longitude: partial.longitude ?? null,
      geohash: null,
      image_url: partial.image_url ?? null,
      status: partial.status ?? 'scheduled',
      availability_status: partial.availability_status ?? null,
      price_min: partial.price_min ?? null,
      price_max: partial.price_max ?? null,
      currency: partial.currency ?? null,
      cover_price: partial.cover_price ?? null,
      table_min_price: partial.table_min_price ?? null,
      venue_rating: partial.venue_rating ?? null,
      venue_popularity_count: partial.venue_popularity_count ?? null,
      dress_code_text: partial.dress_code_text ?? null,
      guest_list_available: partial.guest_list_available ?? null,
      bottle_service_available: partial.bottle_service_available ?? null,
      organizer_name: partial.organizer_name ?? null,
      organizer_event_count: partial.organizer_event_count ?? null,
      organizer_verified: partial.organizer_verified ?? null,
      race_type: partial.race_type ?? null,
      distance_value: partial.distance_value ?? null,
      distance_unit: partial.distance_unit ?? null,
      artists_or_teams: partial.artists_or_teams ?? [],
      registration_url: partial.registration_url ?? null,
      ticket_url: partial.ticket_url ?? null,
      reservation_url: partial.reservation_url ?? null,
      age_minimum: partial.age_minimum ?? null,
      opening_hours_text: partial.opening_hours_text ?? null,
      dedup_hash: '',
      tags: partial.tags ?? [],
      raw_payload: partial.raw_payload ?? {},
      source_updated_at: partial.source_updated_at ?? null,
    };
    merged.geohash =
      merged.latitude != null && merged.longitude != null
        ? this.dedup.geohash(merged.latitude, merged.longitude, 6)
        : null;
    merged.dedup_hash = this.dedup.normalizedDedupKey({
      title: merged.title,
      eventType: merged.event_type,
      startLocal: merged.start_local,
      startAtUTC: merged.start_at_utc,
      timezone: merged.timezone,
      venueName: merged.venue_name,
      city: merged.city,
      state: merged.state,
      latitude: merged.latitude,
      longitude: merged.longitude,
    });
    return merged;
  }

  // ── helpers ──
  private parseNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  private classifyTicketmaster(classification?: {
    segment?: { name?: string };
    genre?: { name?: string };
  }): EventTypeSlug {
    const segment = classification?.segment?.name?.toLowerCase() ?? '';
    if (segment === 'music') return 'concert';
    if (segment === 'sports') return 'sports_event';
    if (segment === 'arts & theatre') return 'theatre';
    return 'other_live_event';
  }

  private mapTicketmasterStatus(code?: string): string {
    switch (code) {
      case 'onsale':
        return 'onsale';
      case 'offsale':
        return 'offsale';
      case 'cancelled':
        return 'cancelled';
      case 'postponed':
        return 'postponed';
      case 'rescheduled':
        return 'rescheduled';
      default:
        return 'scheduled';
    }
  }

  private pickBestImage(
    images?: Array<{ url?: string; width?: number; ratio?: string }>,
  ): string | null {
    if (!images || images.length === 0) return null;
    const sorted = [...images]
      .filter((img) => img.url)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const sixteenNine = sorted.find((img) => img.ratio === '16_9');
    return sixteenNine?.url ?? sorted[0]?.url ?? null;
  }

  private joinDate(
    date?: string | null,
    time?: string | null,
    tz?: string | null,
  ): string | null {
    if (!date) return null;
    const iso = `${date}T${time ?? '00:00:00'}`;
    try {
      const d = new Date(iso + (tz ? '' : 'Z'));
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    } catch {
      return null;
    }
  }

  private runsignupDateToUTC(
    input: string,
    _timezone?: string | null,
  ): string | null {
    const match = input.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2}):(\d{2})/,
    );
    if (!match) return null;
    const [, m, d, y, hh, mm] = match;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:00Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private extractRunSignupPrice(
    periods?: Array<{ race_fee?: string }>,
  ): number | null {
    for (const period of periods ?? []) {
      if (!period.race_fee) continue;
      const numeric = parseFloat(period.race_fee.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
    return null;
  }

  private parseDistance(distance?: string | null): {
    value: number | null;
    unit: string | null;
  } {
    if (!distance) return { value: null, unit: null };
    const match = distance.match(/([\d.]+)\s*(k|km|mi|miles?)/i);
    if (!match) return { value: null, unit: null };
    return {
      value: parseFloat(match[1]),
      unit: match[2].toLowerCase().startsWith('k') ? 'km' : 'mi',
    };
  }

  private stripHtml(value?: string | null): string | null {
    if (!value) return null;
    return (
      value
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null
    );
  }

  private parseAge(ages?: string | number | null): number | null {
    if (ages == null) return null;
    if (typeof ages === 'number') {
      return Number.isFinite(ages) && ages > 0 ? Math.floor(ages) : null;
    }
    const match = String(ages).match(/(\d{2})/);
    return match ? parseInt(match[1], 10) : null;
  }
}

// ── minimal structural types for Eventbrite / RunSignup (helpers keep theirs private) ──
export interface EventbriteRawEvent {
  id?: string;
  name?: string;
  summary?: string;
  url?: string;
  tickets_url?: string;
  timezone?: string;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  image?: { url?: string };
  ticket_availability?: {
    minimum_ticket_price?: { value?: number; currency?: string };
    maximum_ticket_price?: { value?: number; currency?: string };
    is_sold_out?: boolean;
    has_available_tickets?: boolean;
  };
  tags?: Array<{ prefix?: string; tag?: string; display_name?: string }>;
  primary_organizer?: {
    id?: string;
    name?: string;
    num_upcoming_events?: number | null;
  };
  primary_venue?: {
    id?: string;
    name?: string;
    address?: {
      address_1?: string;
      address_2?: string;
      city?: string;
      region?: string;
      postal_code?: string;
      country?: string;
      latitude?: string;
      longitude?: string;
    };
  };
}

export interface RunSignupRaceInput {
  race_id?: number;
  name?: string;
  description?: string;
  url?: string;
  timezone?: string;
  logo_url?: string;
  is_registration_open?: string;
  address?: {
    street?: string;
    street2?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    country_code?: string;
  };
}

export interface RunSignupEventInput {
  event_id?: number;
  name?: string;
  details?: string | null;
  start_time?: string;
  end_time?: string;
  event_type?: string;
  distance?: string;
  registration_periods?: Array<{ race_fee?: string }>;
}
