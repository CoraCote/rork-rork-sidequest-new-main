import { Injectable } from '@nestjs/common';
import {
  AdapterResult,
  EventResult,
  MetroRecord,
  EventbriteListPayload,
  EventbriteItem,
  EventbriteChannel,
  httpClient,
} from '../utils';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EVENTBRITE_COUNTRIES = [
  'united-states',
  'canada',
  'united-kingdom',
  'australia',
  'ireland',
  'new-zealand',
  'germany',
  'france',
  'spain',
  'italy',
  'netherlands',
  'belgium',
  'sweden',
  'denmark',
  'finland',
  'norway',
  'switzerland',
  'austria',
  'portugal',
  'mexico',
  'brazil',
  'argentina',
  'chile',
  'colombia',
  'peru',
  'singapore',
  'hong-kong',
  'japan',
  'india',
  'south-africa',
] as const;

type EventbriteCountry = (typeof EVENTBRITE_COUNTRIES)[number];

interface EventbriteServerDataImage {
  edge_color_set?: boolean;
  edge_color?: string;
  url?: string;
  id?: string;
  image_sizes?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  crop_mask?: unknown;
  aspect_ratio?: number;
  focal_point?: { x?: number; y?: number };
  original?: { url?: string; width?: number; height?: number };
}

interface EventbriteServerDataLocation {
  type?: string;
  id?: string;
  name?: string;
}

interface EventbriteServerDataTag {
  _type?: string;
  prefix?: string;
  tag?: string;
  display_name?: string;
  localized?: { display_name?: string };
}

interface EventbriteServerDataVenueAddress {
  city?: string;
  country?: string;
  region?: string;
  longitude?: string;
  latitude?: string;
  postal_code?: string;
  address_1?: string;
  address_2?: string;
  localized_address_display?: string;
  localized_area_display?: string;
  localized_multi_line_address_display?: string[];
}

interface EventbriteServerDataVenue {
  _type?: string;
  id?: string;
  name?: string;
  venue_profile_id?: string | null;
  venue_profile_url?: string;
  address?: EventbriteServerDataVenueAddress;
}

interface EventbriteServerDataEvent {
  _type?: string;
  id?: string;
  eid?: string;
  eventbrite_event_id?: string;
  name?: string;
  summary?: string;
  full_description?: string | null;
  url?: string;
  tickets_url?: string;
  tickets_by?: string;
  language?: string;
  timezone?: string;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  hide_start_date?: boolean;
  hide_end_date?: boolean;
  published?: string;
  is_online_event?: boolean;
  is_protected_event?: boolean;
  is_cancelled?: boolean | null;
  checkout_flow?: string;
  series_id?: string | null;
  parent_url?: string | null;
  num_children?: number;
  primary_organizer_id?: string;
  primary_venue_id?: string;
  primary_venue?: EventbriteServerDataVenue;
  image_id?: string;
  image?: EventbriteServerDataImage;
  locations?: EventbriteServerDataLocation[];
  tags?: EventbriteServerDataTag[];
  urgency_signals?: { messages?: string[]; categories?: string[] };
  dedup?: { count?: number; hash?: string };
  debug_info?: Record<string, unknown>;
}

interface EventbriteServerDataEventsSection {
  pagination?: {
    object_count?: number;
    page_count?: number;
    page_number?: number;
    page_size?: number;
    continuation?: string;
  };
  results?: EventbriteServerDataEvent[];
}

interface EventbriteServerData {
  app_name?: string;
  search_data?: {
    articles?: Record<string, unknown>;
    current_user_id?: string | null;
    profile_search?: Record<string, unknown>;
    article_search?: Record<string, unknown>;
    profiles?: Record<string, unknown>;
    events?: EventbriteServerDataEventsSection;
  };
}

interface EventbriteDestinationImageOriginal {
  url?: string;
  width?: number;
  height?: number;
}

interface EventbriteDestinationImageCropMask {
  width?: number;
  height?: number;
  top_left?: { x?: number; y?: number };
}

interface EventbriteDestinationImage {
  edge_color_set?: boolean;
  edge_color?: string | null;
  url?: string;
  id?: string | null;
  image_sizes?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  crop_mask?: EventbriteDestinationImageCropMask | null;
  aspect_ratio?: string;
  focal_point?: { x?: number; y?: number } | null;
  original?: EventbriteDestinationImageOriginal;
}

interface EventbriteDestinationSalesDate {
  timezone?: string;
  local?: string;
  utc?: string;
}

interface EventbriteDestinationEventSalesStatus {
  start_sales_date?: EventbriteDestinationSalesDate;
  end_sales_date?: EventbriteDestinationSalesDate;
  default_message?: string | null;
  sales_status?: string;
  currency?: string;
  message_code?: string | null;
  message?: string | null;
  message_type?: string | null;
}

interface EventbriteDestinationPrice {
  currency?: string;
  major_value?: string;
  value?: number;
  display?: string;
}

interface EventbriteDestinationTicketAvailability {
  maximum_ticket_price?: EventbriteDestinationPrice;
  minimum_ticket_price?: EventbriteDestinationPrice;
  is_free?: boolean;
  has_bogo_tickets?: boolean;
  has_available_tickets?: boolean;
  is_sold_out?: boolean;
}

interface EventbriteDestinationPublicCollections {
  creator_collections?: {
    object_count?: number;
    collections?: unknown[];
  };
}

interface EventbriteDestinationVenueAddress {
  city?: string;
  country?: string;
  region?: string;
  longitude?: string;
  latitude?: string;
  postal_code?: string;
  address_1?: string;
  address_2?: string;
  localized_address_display?: string;
  localized_area_display?: string;
  localized_multi_line_address_display?: string[];
}

interface EventbriteDestinationVenue {
  _type?: string;
  id?: string;
  name?: string;
  venue_profile_id?: string | null;
  venue_profile_url?: string;
  address?: EventbriteDestinationVenueAddress;
}

interface EventbriteDestinationTag {
  _type?: string;
  prefix?: string;
  tag?: string;
  display_name?: string;
  localized?: { display_name?: string };
}

interface EventbriteDestinationOrganizer {
  _type?: string;
  id?: string;
  name?: string;
  profile_type?: string;
  url?: string;
  website_url?: string | null;
  summary?: string | null;
  twitter?: string | null;
  facebook?: string | null;
  num_followers?: number | null;
  num_upcoming_events?: number | null;
  num_following?: number | null;
  num_saves?: number | null;
  num_collections?: number | null;
  followed_by_you?: boolean;
  image_id?: string | null;
  image?: EventbriteDestinationImage;
}

interface EventbriteDestinationEvent {
  _type?: string;
  id?: string;
  eid?: string;
  eventbrite_event_id?: string;
  name?: string;
  summary?: string;
  language?: string;
  url?: string;
  tickets_url?: string;
  tickets_by?: string;
  timezone?: string;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  hide_start_date?: boolean;
  hide_end_date?: boolean;
  published?: string;
  status?: string;
  privacy_setting?: string;
  is_online_event?: boolean;
  is_protected_event?: boolean;
  is_cancelled?: boolean | null;
  checkout_flow?: string;
  series_id?: string | null;
  image_id?: string;
  image?: EventbriteDestinationImage;
  saves?: { saved_by_you?: boolean };
  event_sales_status?: EventbriteDestinationEventSalesStatus;
  ticket_availability?: EventbriteDestinationTicketAvailability;
  public_collections?: EventbriteDestinationPublicCollections;
  tags?: EventbriteDestinationTag[];
  primary_organizer_id?: string;
  primary_organizer?: EventbriteDestinationOrganizer;
  primary_venue_id?: string;
  primary_venue?: EventbriteDestinationVenue;
}

export interface EventbriteDestinationEventsResponse {
  pagination?: {
    object_count?: number;
    continuation?: string | null;
    page_count?: number;
    page_size?: number;
    has_more_items?: boolean;
    page_number?: number;
  };
  events: EventbriteDestinationEvent[];
}

@Injectable()
export class EventbriteHelper {
  async fetchEventbrite(
    metro: MetroRecord,
    intent: string,
  ): Promise<AdapterResult> {
    const result: AdapterResult = {
      source: 'eventbrite',
      events: [],
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      avgLatencyMs: 0,
      notes: [],
    };

    const channels = this.buildChannels(metro, intent);
    const latencies: number[] = [];

    for (const channel of channels) {
      result.requestCount++;
      const startedAt = Date.now();

      try {
        const response = await httpClient.get<string>(channel.path, {
          responseType: 'text',
          headers: {
            'User-Agent': DESKTOP_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        latencies.push(Date.now() - startedAt);

        if (response.status < 200 || response.status >= 300) {
          result.failureCount++;
          result.notes.push(
            `Eventbrite ${channel.label}: HTTP ${response.status}`,
          );
          continue;
        }

        const html = response.data;
        const payload = this.extractJsonLd(html);
        if (!payload?.itemListElement?.length) {
          result.failureCount++;
          result.notes.push(
            `Eventbrite ${channel.label}: no JSON-LD listings found`,
          );
          continue;
        }

        result.successCount++;
        const normalized = payload.itemListElement
          .map((entry) => this.normalizeEventbriteListing(entry.item, channel))
          .filter((event): event is EventResult => event !== null);
        result.events.push(...normalized);
      } catch (error) {
        latencies.push(Date.now() - startedAt);
        const isTimeout = (error as { code?: string })?.code === 'ECONNABORTED';
        if (isTimeout) {
          result.timeoutCount++;
          result.notes.push(`Eventbrite ${channel.label}: timeout`);
        } else {
          result.failureCount++;
          result.notes.push(`Eventbrite ${channel.label}: ${String(error)}`);
        }
      }
    }

    result.events = this.dedupeEvents(result.events);
    result.avgLatencyMs =
      latencies.length > 0
        ? Math.round(
            latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
          )
        : 0;

    if (result.events.length === 0 && result.notes.length === 0) {
      result.notes.push('Eventbrite returned no local listings');
    }

    return result;
  }

  private buildChannels(
    metro: MetroRecord,
    intent: string,
  ): EventbriteChannel[] {
    const state = this.slugifyState(metro.state ?? '');
    const city = this.slugify(metro.city ?? '');
    const base = `https://www.eventbrite.com/d/${state}--${city}`;

    switch (intent) {
      case 'biggest_tonight':
        return [
          {
            label: 'all-events',
            path: `${base}/events/`,
            fallbackType: 'other live event',
          },
          {
            label: 'music',
            path: `${base}/music--events/`,
            fallbackType: 'concert',
          },
        ];
      case 'exclusive_hot':
        return [
          {
            label: 'nightlife',
            path: `${base}/nightlife--events/`,
            fallbackType: 'party / nightlife',
          },
          {
            label: 'music',
            path: `${base}/music--events/`,
            fallbackType: 'concert',
          },
        ];
      case 'last_minute_plans':
        return [
          {
            label: 'all-events',
            path: `${base}/events/`,
            fallbackType: 'social / community event',
          },
          {
            label: 'nightlife',
            path: `${base}/nightlife--events/`,
            fallbackType: 'party / nightlife',
          },
        ];
      default:
        return [
          {
            label: 'all-events',
            path: `${base}/events/`,
            fallbackType: 'social / community event',
          },
          {
            label: 'nightlife',
            path: `${base}/nightlife--events/`,
            fallbackType: 'party / nightlife',
          },
          {
            label: 'sports-fitness',
            path: `${base}/sports-and-fitness--events/`,
            fallbackType: 'sports event',
          },
        ];
    }
  }

  private extractJsonLd(html: string): EventbriteListPayload | null {
    const match = html.match(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!match?.[1]) return null;

    try {
      return JSON.parse(match[1].trim()) as EventbriteListPayload;
    } catch {
      return null;
    }
  }

  private normalizeEventbriteListing(
    item: EventbriteItem | undefined,
    channel: EventbriteChannel,
  ): EventResult | null {
    if (!item?.url || !item.name) return null;

    const address = item.location?.address;
    const eventType = this.inferEventbriteType(item, channel);
    const sourceEventId = this.eventbriteIdFromUrl(item.url);

    return {
      id: `eventbrite:${sourceEventId}`,
      source: 'eventbrite',
      sourceEventId,
      sourceUrl: item.url,
      title: item.name,
      shortDescription: this.shorten(item.description),
      fullDescription: item.description || undefined,
      eventType,
      startAtUTC: this.toIsoString(item.startDate),
      endAtUTC: this.toIsoString(item.endDate),
      startLocal: this.toIsoString(item.startDate),
      endLocal: this.toIsoString(item.endDate),
      venueName: item.location?.name || undefined,
      addressLine1: address?.streetAddress || undefined,
      city: address?.addressLocality || undefined,
      state: address?.addressRegion || undefined,
      postalCode: address?.postalCode || undefined,
      country: address?.addressCountry || 'US',
      latitude: item.location?.geo?.latitude
        ? parseFloat(item.location.geo.latitude)
        : undefined,
      longitude: item.location?.geo?.longitude
        ? parseFloat(item.location.geo.longitude)
        : undefined,
      imageUrl: item.image || undefined,
      status: 'scheduled',
      ticketUrl: item.url,
      tags: [channel.label].filter(Boolean),
      rawSourcePayload: {
        eventbrite_url: item.url,
        eventbrite_channel: channel.label,
        eventbrite_location_name: item.location?.name,
      },
    };
  }

  private inferEventbriteType(
    item: EventbriteItem | undefined,
    channel: EventbriteChannel,
  ): string {
    const content =
      `${item?.name || ''} ${item?.description || ''}`.toLowerCase();
    const channelHint = channel.label.toLowerCase();
    if (
      content.includes('kids') ||
      content.includes('family') ||
      content.includes('playdate') ||
      content.includes('workshop') ||
      content.includes('screening') ||
      content.includes('panel')
    ) {
      return 'social / community event';
    }
    if (
      content.includes('nightlife') ||
      content.includes('party') ||
      content.includes('dj') ||
      (content.includes('club') &&
        !content.includes('kids club') &&
        !content.includes('clubhouse'))
    ) {
      return 'party / nightlife';
    }
    if (
      content.includes('music') ||
      content.includes('concert') ||
      content.includes('festival')
    ) {
      return 'concert';
    }
    if (
      content.includes('sports') ||
      content.includes('fitness') ||
      content.includes('run')
    ) {
      return 'sports event';
    }
    if (content.includes('comedy')) return 'other live event';
    if (content.includes('market') || content.includes('community')) {
      return 'social / community event';
    }
    if (channelHint.includes('nightlife')) return 'party / nightlife';
    if (channelHint.includes('music')) return 'concert';
    if (channelHint.includes('sports')) return 'sports event';
    return channel.fallbackType;
  }

  private dedupeEvents(events: EventResult[]): EventResult[] {
    const deduped = new Map<string, EventResult>();
    for (const event of events) {
      const key = event.ticketUrl || event.sourceEventId;
      if (!deduped.has(key)) {
        deduped.set(key, event);
      }
    }
    return [...deduped.values()];
  }

  private eventbriteIdFromUrl(url: string): string {
    const match = url.match(/-tickets-(\d+)/);
    return match?.[1] || this.slugify(url);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private slugifyState(value: string): string {
    return value.trim().toLowerCase();
  }

  private shorten(value?: string, maxLength: number = 220): string | undefined {
    if (!value) return undefined;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, maxLength - 3).trim()}...`;
  }

  private toIsoString(value?: string): string | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  async fetchCountryEventListing(
    country: EventbriteCountry,
    page: number,
  ): Promise<{
    eventIds: string[];
    pageSize: number;
  }> {
    const url = `https://www.eventbrite.com/d/${country}/all-events/?page=${page}`;
    const response = await httpClient.get<string>(url, {
      responseType: 'text',
      headers: {
        'User-Agent': DESKTOP_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Eventbrite listing HTTP ${response.status}`);
    }

    const html = response.data;
    const serverData = this.extractServerData(html);
    if (!serverData) {
      throw new Error('window.__SERVER_DATA__ not found in Eventbrite HTML');
    }

    const eventsSection = serverData.search_data?.events;
    const results = eventsSection?.results ?? [];

    const eventIds = results
      .map((entry) => entry?.eventbrite_event_id)
      .filter((id): id is string => id !== undefined && id !== null)
      .map((id) => String(id));

    const pageSize = eventsSection?.pagination?.page_size ?? eventIds.length;

    return { eventIds, pageSize };
  }

  async fetchDestinationEvents(
    eventIds: string[],
    pageSize: number,
  ): Promise<EventbriteDestinationEventsResponse> {
    if (eventIds.length === 0) {
      return { events: [] };
    }

    const idsParam = eventIds.join(',');
    const expand = [
      'event_sales_status',
      'image',
      'primary_venue',
      'saves',
      'ticket_availability',
      'primary_organizer',
      'primary_organizer.image',
      'public_collections',
    ].join(',');
    const url = `https://www.eventbrite.com/api/v3/destination/events/?event_ids=${idsParam}&page_size=${pageSize}&expand=${expand}`;

    const response = await httpClient.get<EventbriteDestinationEventsResponse>(
      url,
      {
        headers: {
          'User-Agent': DESKTOP_USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'application/json, text/plain, */*',
        },
      },
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Eventbrite destination HTTP ${response.status}`);
    }

    return response.data;
  }

  async fetchUnitedStatesEventsDetailed(
    page = 1,
  ): Promise<EventbriteDestinationEventsResponse> {
    const country = EVENTBRITE_COUNTRIES[0];
    const { eventIds, pageSize } = await this.fetchCountryEventListing(
      country,
      page,
    );
    const events = await this.fetchDestinationEvents(eventIds, pageSize);
    return events;
  }

  private extractServerData(html: string): EventbriteServerData | null {
    const marker = 'window.__SERVER_DATA__';
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) return null;

    const startBrace = html.indexOf('{', markerIndex);
    if (startBrace === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    let endIndex = -1;

    for (let i = startBrace; i < html.length; i++) {
      const char = html[i];

      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }

    if (endIndex === -1) return null;

    const jsonText = html.slice(startBrace, endIndex + 1);
    try {
      return JSON.parse(jsonText) as EventbriteServerData;
    } catch {
      return null;
    }
  }
}
