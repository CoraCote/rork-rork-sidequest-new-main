import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { TicketmasterHelper } from '../../helpers/ticketmaster.helper';
import { EventbriteHelper } from '../../helpers/eventbrite.helper';
import { RunSignupHelper } from '../../helpers/runsignup.helper';
import { DiscotechHelper } from '../../helpers/discotech.helper';
import { ClubbableHelper } from '../../helpers/clubbable.helper';
import { OsmHelper } from '../../helpers/osm.helper';
import {
  EventNormalizerHelper,
  NormalizedEvent,
} from '../../helpers/event-normalizer.helper';
import { EventsRepositoryHelper } from '../../helpers/events-repository.helper';
import { ViewportQueryDto } from '../../dtos';

const LA_BBOX = {
  minLat: 33.7,
  maxLat: 34.34,
  minLng: -118.67,
  maxLng: -118.15,
} as const;

const LA_CENTER = { lat: 34.0522, lng: -118.2437 } as const;

@Injectable()
export class EventsService {
  constructor(
    private readonly ticketmaster: TicketmasterHelper,
    private readonly eventbrite: EventbriteHelper,
    private readonly runsignup: RunSignupHelper,
    private readonly discotech: DiscotechHelper,
    private readonly clubbable: ClubbableHelper,
    private readonly osm: OsmHelper,
    private readonly normalizer: EventNormalizerHelper,
    private readonly repository: EventsRepositoryHelper,
    @InjectPinoLogger(EventsService.name)
    private readonly logger: PinoLogger,
  ) {}

  async ingestLosAngeles(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const results = await Promise.allSettled([
      this.ingestTicketmasterLA(),
      this.ingestEventbriteLA(),
      this.ingestRunSignupLA(),
      this.ingestDiscotechLA(),
      this.ingestClubbableLA(),
    ]);

    const summary: Record<string, unknown> = {};
    const labels = [
      'ticketmaster',
      'eventbrite',
      'runsignup',
      'discotech',
      'clubbable',
    ];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        summary[labels[i]] = r.value;
      } else {
        summary[labels[i]] = {
          error:
            r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      }
    });

    summary.durationMs = Date.now() - started;
    summary.nominatimRequests = this.osm.getRequestCount();
    summary.nominatimCacheHits = this.osm.getCacheHitCount();
    this.logger.info(summary, 'LA ingestion finished');
    return summary;
  }

  private async ingestTicketmasterLA() {
    const events = await this.ticketmaster.searchAllEvents({
      latlong: `${LA_CENTER.lat},${LA_CENTER.lng}`,
      radius: 30,
      unit: 'miles',
    });
    const normalized: NormalizedEvent[] = [];
    for (const e of events) {
      const n = this.normalizer.fromTicketmaster(e);
      if (n && this.inLaBbox(n.latitude, n.longitude)) normalized.push(n);
    }
    const written = await this.repository.upsertAndMerge(normalized);
    return {
      fetched: events.length,
      normalized: normalized.length,
      ...written,
    };
  }

  private async ingestEventbriteLA() {
    const response = await this.eventbrite.fetchUnitedStatesEventsDetailed();
    const events = response?.events ?? [];
    const normalized: NormalizedEvent[] = [];
    for (const e of events) {
      const n = this.normalizer.fromEventbrite(e);
      if (n && this.inLaBbox(n.latitude, n.longitude)) normalized.push(n);
    }
    const written = await this.repository.upsertAndMerge(normalized);
    return {
      fetched: events.length,
      normalized: normalized.length,
      ...written,
    };
  }

  private async ingestRunSignupLA() {
    const result = await this.runsignup.searchRacesWithDetails({
      city: 'Los Angeles',
      state: 'CA',
      radius: 30,
    });
    const normalized: NormalizedEvent[] = [];
    let geocoded = 0;
    let geocodeMisses = 0;

    for (const entry of result.details) {
      if (!('detail' in entry) || !entry.detail) continue;
      const race = entry.detail.race;
      if (!race?.events?.length) continue;

      const location = await this.geocodeRunSignupRace(race);
      if (location.latitude == null || location.longitude == null) {
        geocodeMisses++;
      } else {
        geocoded++;
      }

      for (const event of race.events) {
        const n = this.normalizer.fromRunSignup(race, event, location);
        if (n && this.inLaBbox(n.latitude, n.longitude)) normalized.push(n);
      }
    }

    const written = await this.repository.upsertAndMerge(normalized);
    return {
      fetched: result.events.length,
      normalized: normalized.length,
      geocoded,
      geocodeMisses,
      ...written,
    };
  }

  private async geocodeRunSignupRace(race: {
    address?: {
      street?: string;
      street2?: string;
      city?: string;
      state?: string;
      zipcode?: string;
      country_code?: string;
    };
  }): Promise<{ latitude: number | null; longitude: number | null }> {
    const addr = race.address;
    if (!addr) return { latitude: LA_CENTER.lat, longitude: LA_CENTER.lng };
    const street = [addr.street, addr.street2].filter(Boolean).join(' ');
    const result = await this.osm.geocodeAddress({
      street: street || null,
      city: addr.city ?? null,
      state: addr.state ?? null,
      postalCode: addr.zipcode ?? null,
      country: addr.country_code ?? 'US',
    });
    if (result) {
      return { latitude: result.latitude, longitude: result.longitude };
    }
    return { latitude: LA_CENTER.lat, longitude: LA_CENTER.lng };
  }

  private async ingestDiscotechLA() {
    const venuesWithEvents = await this.discotech.fetchVenuesWithEvents();
    const laVenues = venuesWithEvents.filter(
      (v) =>
        v.city?.name?.toLowerCase() === 'los angeles' ||
        this.inLaBbox(v.lat ?? null, v.lng ?? null),
    );

    const normalized: NormalizedEvent[] = [];
    for (const entry of laVenues) {
      const venueLike = {
        _type: 'Venue' as const,
        id: entry.venue_id,
        name: entry.name,
        slug: entry.venue_slug,
        description: entry.description,
        description_short: entry.description,
        hotel_name: entry.hotel_name,
        hours: entry.hours,
        dress_code: entry.dress_code,
        music: entry.music,
        capacity: entry.capacity,
        price_level: entry.price_level,
        popularity: entry.popularity,
        street_address: entry.street_address,
        zip_code: entry.zip_code,
        full_address: entry.full_address,
        lat: entry.lat,
        lng: entry.lng,
        timezone: entry.timezone,
        google_place_id: entry.google_place_id,
        url: entry.url,
        logo_url: entry.logo_url,
        hero_image_url: entry.hero_image_url,
        flyer_image_url: null,
        image_urls: entry.image_urls,
        floor_plan_image_urls: [],
        menu_image_urls: [],
        status: entry.status,
        city: entry.city,
        is_published: true,
        city_id: 0,
        table_reservation_require_ratio: false,
        created_at: '',
        first_event_date: null,
        last_event_date: null,
        is_new: false,
        redirect_venue_id: null,
        has_discounted_tickets: false,
        has_special_pricing: false,
        has_events_with_guest_list: null,
        has_events_with_tickets: null,
        has_events_with_table_reservations: null,
        ticket_discount_type: null,
        ticket_discount_amount: null,
        ticket_discount_message: null,
        upcoming_events: [],
        google_streetview_panorama_id: '',
        is_favorited: false,
      };

      const venueNorm = this.normalizer.fromDiscotechVenue(
        venueLike as unknown as Parameters<
          EventNormalizerHelper['fromDiscotechVenue']
        >[0],
        entry.events,
      );
      if (venueNorm && this.inLaBbox(venueNorm.latitude, venueNorm.longitude)) {
        normalized.push(venueNorm);
      }
      for (const event of entry.events) {
        const n = this.normalizer.fromDiscotechEvent(
          event,
          venueLike as unknown as Parameters<
            EventNormalizerHelper['fromDiscotechEvent']
          >[1],
        );
        if (n && this.inLaBbox(n.latitude, n.longitude)) normalized.push(n);
      }
    }

    const written = await this.repository.upsertAndMerge(normalized);
    return {
      fetched: venuesWithEvents.length,
      la: laVenues.length,
      normalized: normalized.length,
      ...written,
    };
  }

  private async ingestClubbableLA() {
    const city = await this.clubbable
      .fetchCityWithClubs('Los-Angeles')
      .catch(() => null);
    if (!city)
      return { fetched: 0, normalized: 0, inserted: 0, merged: 0, skipped: 0 };
    const normalized: NormalizedEvent[] = [];
    for (const club of city.clubs) {
      const n = this.normalizer.fromClubbable(city, club);
      if (n && this.inLaBbox(n.latitude, n.longitude)) normalized.push(n);
    }
    const written = await this.repository.upsertAndMerge(normalized);
    return {
      fetched: city.clubs.length,
      normalized: normalized.length,
      ...written,
    };
  }

  private inLaBbox(lat: number | null, lng: number | null): boolean {
    if (lat == null || lng == null) return false;
    return (
      lat >= LA_BBOX.minLat &&
      lat <= LA_BBOX.maxLat &&
      lng >= LA_BBOX.minLng &&
      lng <= LA_BBOX.maxLng
    );
  }

  async queryViewport(dto: ViewportQueryDto) {
    return this.repository.queryViewport({
      minLat: dto.minLat,
      maxLat: dto.maxLat,
      minLng: dto.minLng,
      maxLng: dto.maxLng,
      startAfterUTC: dto.startAfterUTC ?? null,
      limit: dto.limit,
    });
  }
}
