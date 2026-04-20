import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { NormalizeHelper } from './normalize.helper';
import {
  AdapterResult,
  EventResult,
  MetroRecord,
  TmEvent,
  httpClient,
} from '../utils';
import { TicketmasterSearchDto } from '../dtos';

const CLASSIFICATION_CHANNELS = [
  { classificationName: 'Music', eventType: 'concert' },
  { classificationName: 'Sports', eventType: 'sports event' },
  { classificationName: 'Arts & Theatre', eventType: 'other live event' },
  { classificationName: 'Comedy', eventType: 'other live event' },
];

export interface TicketmasterImage {
  ratio?: string;
  url?: string;
  width?: number;
  height?: number;
  fallback?: boolean;
}

export interface TicketmasterClassification {
  primary?: boolean;
  segment?: { id?: string; name?: string };
  genre?: { id?: string; name?: string };
  subGenre?: { id?: string; name?: string };
  type?: { id?: string; name?: string };
  subType?: { id?: string; name?: string };
  family?: boolean;
}

export interface TicketmasterVenueFull {
  name?: string;
  type?: string;
  id?: string;
  test?: boolean;
  locale?: string;
  postalCode?: string;
  timezone?: string;
  city?: { name?: string };
  state?: { name?: string; stateCode?: string };
  country?: { name?: string; countryCode?: string };
  address?: { line1?: string; line2?: string; line3?: string };
  location?: { latitude?: string; longitude?: string };
  markets?: Array<{ id?: string }>;
  _links?: { self?: { href?: string } };
}

export interface TicketmasterAttraction {
  name?: string;
  type?: string;
  id?: string;
  test?: boolean;
  locale?: string;
  images?: TicketmasterImage[];
  classifications?: TicketmasterClassification[];
  _links?: { self?: { href?: string } };
}

export interface TicketmasterEventFull {
  name?: string;
  type?: string;
  id?: string;
  test?: boolean;
  url?: string;
  locale?: string;
  images?: TicketmasterImage[];
  sales?: {
    public?: {
      startDateTime?: string;
      startTBD?: boolean;
      endDateTime?: string;
    };
    presales?: Array<{
      startDateTime?: string;
      endDateTime?: string;
      name?: string;
    }>;
  };
  dates?: {
    start?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
      dateTBD?: boolean;
      dateTBA?: boolean;
      timeTBA?: boolean;
      noSpecificTime?: boolean;
    };
    end?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
    };
    timezone?: string;
    status?: { code?: string };
    spanMultipleDays?: boolean;
  };
  classifications?: TicketmasterClassification[];
  promoter?: { id?: string; name?: string; description?: string };
  promoters?: Array<{ id?: string; name?: string; description?: string }>;
  info?: string;
  pleaseNote?: string;
  priceRanges?: Array<{
    type?: string;
    currency?: string;
    min?: number;
    max?: number;
  }>;
  seatmap?: { staticUrl?: string };
  ticketLimit?: { info?: string };
  ageRestrictions?: { legalAgeEnforced?: boolean };
  _links?: {
    self?: { href?: string };
    attractions?: Array<{ href?: string }>;
    venues?: Array<{ href?: string }>;
  };
  _embedded?: {
    venues?: TicketmasterVenueFull[];
    attractions?: TicketmasterAttraction[];
  };
}

export interface TicketmasterEventsResponse {
  _links?: {
    self?: { href?: string; templated?: boolean };
    next?: { href?: string; templated?: boolean };
    prev?: { href?: string; templated?: boolean };
    first?: { href?: string; templated?: boolean };
    last?: { href?: string; templated?: boolean };
  };
  _embedded?: {
    events?: TicketmasterEventFull[];
  };
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
  };
}

@Injectable()
export class TicketmasterHelper {
  private readonly baseUrl = 'https://app.ticketmaster.com/discovery/v2';
  private readonly pageSize = 20;
  private readonly maxPaginatedItems = 1000;
  private readonly maxPagesPerSlice = 50;
  private readonly requestsPerSecond = 5;
  private readonly minRequestSpacingMs = 1000 / 5;
  private readonly segmentIds: Record<string, string> = {
    Music: 'KZFzniwnSyZfZ7v7nJ',
    Sports: 'KZFzniwnSyZfZ7v7nE',
    'Arts & Theatre': 'KZFzniwnSyZfZ7v7na',
    Film: 'KZFzniwnSyZfZ7v7nn',
    Miscellaneous: 'KZFzniwnSyZfZ7v7n1',
    Family: 'KZFzniwnSyZfZ7v7nl',
  };
  private nextRequestAt = 0;
  private apiCallCount = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly normalize: NormalizeHelper,
    @InjectPinoLogger(TicketmasterHelper.name)
    private readonly logger: PinoLogger,
  ) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.nextRequestAt - now;
    this.nextRequestAt =
      Math.max(now, this.nextRequestAt) + this.minRequestSpacingMs;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    this.apiCallCount++;
  }

  async fetchTicketmaster(
    metro: MetroRecord,
    intent: string,
  ): Promise<AdapterResult> {
    const apiKey = this.configService.get<string>('apiKeys.ticketmaster')!;
    const result: AdapterResult = {
      source: 'ticketmaster',
      events: [],
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      avgLatencyMs: 0,
      notes: [],
    };

    const isHighDensity = this.normalize.isHighDensityMetro(metro.city ?? '');
    const radiusMiles =
      intent === 'biggest_tonight'
        ? isHighDensity
          ? 45
          : 35
        : isHighDensity
          ? 28
          : 20;
    const pageSize = intent === 'biggest_tonight' ? 60 : 40;
    const latencies: number[] = [];

    for (const channel of CLASSIFICATION_CHANNELS) {
      const url = new URL(
        'https://app.ticketmaster.com/discovery/v2/events.json',
      );
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('countryCode', metro.country_code ?? 'US');
      url.searchParams.set('classificationName', channel.classificationName);
      url.searchParams.set('latlong', `${metro.latitude},${metro.longitude}`);
      url.searchParams.set('radius', String(radiusMiles));
      url.searchParams.set('unit', 'miles');
      url.searchParams.set('size', String(pageSize));
      url.searchParams.set('sort', 'date,asc');
      url.searchParams.set('startDateTime', this.upcomingStartDateTime());

      if (metro.state) {
        url.searchParams.set('stateCode', metro.state);
      }

      result.requestCount++;
      const start = Date.now();

      try {
        const response = await httpClient.get<{
          _embedded?: { events?: TmEvent[] };
        }>(url.toString(), {
          headers: { Accept: 'application/json' },
        });

        const latency = Date.now() - start;
        latencies.push(latency);

        if (response.status < 200 || response.status >= 300) {
          result.failureCount++;
          result.notes.push(
            `Ticketmaster ${channel.classificationName}: HTTP ${response.status}`,
          );
          continue;
        }

        result.successCount++;
        const embedded = response.data?._embedded?.events;

        if (!embedded || embedded.length === 0) continue;

        for (const raw of embedded) {
          const event = this.normalizeTmEvent(raw, channel.eventType);
          if (event) result.events.push(event);
        }
      } catch (err: unknown) {
        const latency = Date.now() - start;
        latencies.push(latency);
        const isTimeout = (err as { code?: string })?.code === 'ECONNABORTED';
        if (isTimeout) {
          result.timeoutCount++;
          result.notes.push(
            `Ticketmaster ${channel.classificationName}: timeout`,
          );
        } else {
          result.failureCount++;
          result.notes.push(
            `Ticketmaster ${channel.classificationName}: ${String(err)}`,
          );
        }
      }
    }

    result.avgLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;

    return result;
  }

  private normalizeTmEvent(
    raw: TmEvent,
    defaultEventType: string,
  ): EventResult | null {
    if (!raw.id || !raw.name) return null;

    const venue = raw._embedded?.venues?.[0];
    const classification = raw.classifications?.[0];
    const segment = classification?.segment?.name?.toLowerCase() ?? '';
    const genre = classification?.genre?.name?.toLowerCase() ?? '';

    let eventType = defaultEventType;
    if (
      segment === 'music' ||
      genre.includes('music') ||
      genre.includes('rock') ||
      genre.includes('pop')
    ) {
      eventType = 'concert';
    } else if (segment === 'sports') {
      eventType = 'sports event';
    }

    const bestImage = this.pickBestImage(raw.images);
    const priceRange = raw.priceRanges?.[0];

    return {
      id: `ticketmaster:${raw.id}`,
      source: 'ticketmaster',
      sourceEventId: raw.id,
      sourceParentId: venue?.id,
      sourceUrl: raw.url,
      title: raw.name,
      shortDescription: raw.info?.substring(0, 200),
      fullDescription: raw.info,
      category: classification?.segment?.name,
      subcategory: classification?.genre?.name,
      eventType,
      startAtUTC: raw.dates?.start?.dateTime,
      startLocal: raw.dates?.start?.localDate
        ? `${raw.dates.start.localDate}T${raw.dates.start.localTime || '00:00:00'}`
        : undefined,
      endAtUTC: raw.dates?.end?.dateTime,
      timezone: venue?.timezone || raw.dates?.timezone,
      venueName: venue?.name,
      venueId: venue?.id,
      addressLine1: venue?.address?.line1,
      city: venue?.city?.name,
      state: venue?.state?.stateCode,
      postalCode: venue?.postalCode,
      country: venue?.country?.countryCode,
      latitude: venue?.location?.latitude
        ? parseFloat(venue.location.latitude)
        : undefined,
      longitude: venue?.location?.longitude
        ? parseFloat(venue.location.longitude)
        : undefined,
      imageUrl: bestImage,
      status: this.mapTmStatus(raw.dates?.status?.code),
      priceMin: priceRange?.min,
      priceMax: priceRange?.max,
      currency: priceRange?.currency,
      ticketUrl: raw.url,
      tags: [
        classification?.segment?.name,
        classification?.genre?.name,
        classification?.subGenre?.name,
      ].filter(Boolean) as string[],
      rawSourcePayload: {
        ticketmaster_id: raw.id,
        ticketmaster_url: raw.url,
        classification_segment: classification?.segment?.name,
        classification_genre: classification?.genre?.name,
      },
    };
  }

  private pickBestImage(
    images?: Array<{ url?: string; width?: number; ratio?: string }>,
  ): string | undefined {
    if (!images || images.length === 0) return undefined;
    const preferred = images
      .filter(
        (img) => img.url && img.ratio === '16_9' && (img.width ?? 0) >= 640,
      )
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return preferred[0]?.url || images[0]?.url;
  }

  private mapTmStatus(code?: string): string {
    switch (code) {
      case 'onsale':
        return 'onsale';
      case 'offsale':
        return 'scheduled';
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

  private upcomingStartDateTime(): string {
    const now = new Date();
    return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  async searchEvents(
    params: TicketmasterSearchDto = {},
  ): Promise<TicketmasterEventsResponse> {
    const apiKey = this.configService.get<string>('apiKeys.ticketmaster')!;
    const url = new URL(`${this.baseUrl}/events.json`);
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('size', String(this.pageSize));
    url.searchParams.set('page', String(params.page ?? 0));
    url.searchParams.set('sort', params.sort ?? 'date,asc');
    url.searchParams.set('locale', params.locale ?? '*');
    url.searchParams.set('countryCode', params.countryCode ?? 'US');

    const optionalKeys: Array<Extract<keyof TicketmasterSearchDto, string>> = [
      'keyword',
      'attractionId',
      'venueId',
      'postalCode',
      'latlong',
      'radius',
      'unit',
      'source',
      'marketId',
      'startDateTime',
      'endDateTime',
      'includeTBA',
      'includeTBD',
      'includeTest',
      'city',
      'stateCode',
      'classificationName',
      'classificationId',
      'dmaId',
      'segmentId',
      'segmentName',
      'promoterId',
      'genreId',
      'subGenreId',
      'geoPoint',
      'preferredCountry',
      'includeSpellcheck',
    ];

    for (const key of optionalKeys) {
      const value = params[key];
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    await this.throttle();
    const response = await httpClient.get<TicketmasterEventsResponse>(
      url.toString(),
      { headers: { Accept: 'application/json' } },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Ticketmaster events HTTP ${response.status}`);
    }
    return response.data;
  }

  async searchAllEvents(
    params: TicketmasterSearchDto = {},
  ): Promise<TicketmasterEventFull[]> {
    const collected = new Map<string, TicketmasterEventFull>();
    const startCount = this.apiCallCount;
    const startedAt = Date.now();

    const now = new Date();
    const defaultStartDate = new Date(now);
    defaultStartDate.setMonth(defaultStartDate.getMonth() - 3);
    const defaultStart = this.formatDateTime(defaultStartDate);
    const defaultEndDate = new Date(now);
    defaultEndDate.setFullYear(defaultEndDate.getFullYear() + 2);
    const defaultEnd = this.formatDateTime(defaultEndDate);

    await this.collectSlice(
      {
        ...params,
        startDateTime: params.startDateTime ?? defaultStart,
        endDateTime: params.endDateTime ?? defaultEnd,
      },
      collected,
    );

    const apiCalls = this.apiCallCount - startCount;
    const durationMs = Date.now() - startedAt;
    this.logger.info({
      apiCalls,
      durationMs,
      collected: collected.size,
      message: `Ticketmaster searchAllEvents made ${apiCalls} API calls in ${durationMs}ms, collected ${collected.size} unique events`,
    });

    return Array.from(collected.values());
  }

  private async collectSlice(
    params: TicketmasterSearchDto,
    collected: Map<string, TicketmasterEventFull>,
  ): Promise<void> {
    const first = await this.searchEvents({ ...params, page: 0 });
    const total = first.page?.totalElements ?? 0;
    if (total === 0) return;

    if (total <= this.maxPaginatedItems) {
      this.mergeEvents(first._embedded?.events, collected);
      const totalPages = Math.min(
        first.page?.totalPages ?? 1,
        this.maxPagesPerSlice,
      );
      for (let page = 1; page < totalPages; page++) {
        const next = await this.searchEvents({ ...params, page });
        this.mergeEvents(next._embedded?.events, collected);
      }
      return;
    }

    if (await this.subdivideByDate(params, collected)) return;
    if (await this.subdivideBySegment(params, collected)) return;

    this.mergeEvents(first._embedded?.events, collected);
    const cappedPages = this.maxPagesPerSlice;
    for (let page = 1; page < cappedPages; page++) {
      const next = await this.searchEvents({ ...params, page });
      this.mergeEvents(next._embedded?.events, collected);
    }
  }

  private async subdivideByDate(
    params: TicketmasterSearchDto,
    collected: Map<string, TicketmasterEventFull>,
  ): Promise<boolean> {
    const start = params.startDateTime ? new Date(params.startDateTime) : null;
    const end = params.endDateTime ? new Date(params.endDateTime) : null;
    if (!start || !end) return false;
    const spanMs = end.getTime() - start.getTime();
    if (spanMs <= 1000 * 60 * 60 * 24) return false;

    const midMs = start.getTime() + Math.floor(spanMs / 2);
    const mid = new Date(midMs);
    const midStart = this.formatDateTime(mid);
    const midEnd = this.formatDateTime(new Date(midMs - 1000));

    await this.collectSlice({ ...params, endDateTime: midEnd }, collected);
    await this.collectSlice({ ...params, startDateTime: midStart }, collected);
    return true;
  }

  private async subdivideBySegment(
    params: TicketmasterSearchDto,
    collected: Map<string, TicketmasterEventFull>,
  ): Promise<boolean> {
    if (params.segmentId) return false;
    for (const segmentId of Object.values(this.segmentIds)) {
      await this.collectSlice({ ...params, segmentId }, collected);
    }
    return true;
  }

  private mergeEvents(
    events: TicketmasterEventFull[] | undefined,
    collected: Map<string, TicketmasterEventFull>,
  ): void {
    if (!events) return;
    for (const event of events) {
      if (event.id && !collected.has(event.id)) {
        collected.set(event.id, event);
      }
    }
  }

  private formatDateTime(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  async getEventDetail(eventId: string): Promise<TicketmasterEventFull> {
    const apiKey = this.configService.get<string>('apiKeys.ticketmaster')!;
    const url = new URL(`${this.baseUrl}/events/${eventId}.json`);
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('locale', '*');

    await this.throttle();
    const response = await httpClient.get<TicketmasterEventFull>(
      url.toString(),
      { headers: { Accept: 'application/json' } },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Ticketmaster event ${eventId} HTTP ${response.status}`);
    }
    return response.data;
  }
}
