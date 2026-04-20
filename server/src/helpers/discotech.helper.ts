import { Injectable } from '@nestjs/common';
import { httpClient } from '../utils';
import { DiscotechVenueEventsDto, DiscotechVenuesDto } from '../dtos';

export interface DiscotechPagination {
  object_count: number;
  page_size: number;
  page_number: number;
  page_count: number;
  next: string | null;
  prev: string | null;
}

export interface DiscotechRegion {
  code: string;
  name: string;
}

export interface DiscotechCountry {
  code: string;
  name: string;
}

export interface DiscotechCity {
  _type: 'City';
  id: number;
  slug: string;
  created_at: string;
  name: string;
  state: string;
  region: DiscotechRegion;
  country: DiscotechCountry;
  timezone: string;
  lat: number;
  lng: number;
  url: string;
  hero_image_url: string | null;
  is_new: boolean;
  has_experiences: boolean;
  _expansions?: string[];
}

export interface DiscotechVenueStatus {
  value: string;
  label: string;
}

export interface DiscotechVenue {
  _type: 'Venue';
  id: number;
  created_at: string;
  name: string;
  slug: string;
  is_published: boolean;
  hotel_name: string;
  hours: string;
  dress_code: string;
  capacity: number | null;
  city_id: number;
  city?: DiscotechCity;
  street_address: string;
  zip_code: string;
  music: string;
  timezone: string;
  description: string;
  description_short: string;
  full_address: string;
  price_level: number;
  url: string;
  logo_url: string | null;
  flyer_image_url: string | null;
  hero_image_url: string | null;
  image_urls: string[];
  floor_plan_image_urls: string[];
  menu_image_urls: string[];
  table_reservation_require_ratio: boolean;
  lat: number;
  lng: number;
  google_place_id: string;
  google_streetview_panorama_id: string;
  is_favorited: boolean;
  status: DiscotechVenueStatus;
  first_event_date: string | null;
  last_event_date: string | null;
  is_new: boolean;
  redirect_venue_id: number | null;
  has_discounted_tickets: boolean;
  has_special_pricing: boolean;
  has_events_with_guest_list: boolean | null;
  has_events_with_tickets: boolean | null;
  has_events_with_table_reservations: boolean | null;
  popularity: number;
  ticket_discount_type: string | null;
  ticket_discount_amount: number | null;
  ticket_discount_message: string | null;
  upcoming_events: unknown[];
  _expansions?: string[];
}

export interface DiscotechGuestList {
  guest_list_closed: boolean;
  signups_disabled: boolean;
  benefit: string;
  type: string | null;
  is_girls_only: boolean;
  last_signup: string | null;
  last_entry: string | null;
  max_additional_guests: number;
}

export interface DiscotechEvent {
  _type: 'Event';
  id: number;
  name: string;
  venue_id: number;
  url: string;
  description: string;
  is_published: boolean;
  image_url: string | null;
  start: string;
  start_utc: string;
  end: string;
  end_utc: string;
  music: string;
  type: string;
  ages: string | null;
  has_guest_list: boolean;
  guest_list: DiscotechGuestList;
  has_discounted_tickets: boolean;
  has_table_reservations: boolean;
  has_offline_bookings: boolean;
  table_reservation_cutoff: string | null;
  table_reservation_cutoff_utc: string | null;
  has_tickets: boolean;
  ticket_provider: string;
  ticket_sales_end: string | null;
  ticket_sales_end_utc: string | null;
  external_ticket_url: string | null;
  external_ticket_message: string | null;
  resale_ticket_url: string | null;
  resale_ticket_message: string | null;
  tickets: unknown[];
  live_stream_url: string | null;
  live_stream_message: string | null;
  use_gender_ratio: boolean;
  _expansions?: string[];
  _user_bookings?: unknown[];
}

export interface DiscotechResponse<T> {
  message: string | null;
  pagination: DiscotechPagination;
  announcements: unknown[];
  data: T[];
}

@Injectable()
export class DiscotechHelper {
  private readonly baseUrl = 'https://api.discotech.me/v2.2';

  async fetchVenues(
    params: DiscotechVenuesDto = {},
  ): Promise<DiscotechResponse<DiscotechVenue>> {
    const url = new URL(`${this.baseUrl}/venues`);
    url.searchParams.set('expand', 'city');
    url.searchParams.set('page', String(params.page ?? 1));

    const response = await httpClient.get<DiscotechResponse<DiscotechVenue>>(
      url.toString(),
      { headers: { Accept: 'application/json' } },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Discotech venues HTTP ${response.status}`);
    }
    return response.data;
  }

  async fetchVenueEvents(
    params: DiscotechVenueEventsDto,
  ): Promise<DiscotechResponse<DiscotechEvent>> {
    const url = new URL(`${this.baseUrl}/events`);
    url.searchParams.set('venue_slug', params.venue_slug);
    url.searchParams.set('city_slug', params.city_slug);
    url.searchParams.set('expand', 'tickets');
    url.searchParams.set('page', String(params.page ?? 1));

    const response = await httpClient.get<DiscotechResponse<DiscotechEvent>>(
      url.toString(),
      { headers: { Accept: 'application/json' } },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Discotech events HTTP ${response.status}`);
    }
    return response.data;
  }

  async fetchVenuesWithEvents(params: DiscotechVenuesDto = {}): Promise<
    Array<{
      venue_id: number;
      venue_slug: string;
      city_slug: string;
      name: string;
      description: string;
      hotel_name: string;
      hours: string;
      dress_code: string;
      music: string;
      capacity: number | null;
      price_level: number;
      popularity: number;
      street_address: string;
      zip_code: string;
      full_address: string;
      lat: number;
      lng: number;
      timezone: string;
      google_place_id: string;
      url: string;
      logo_url: string | null;
      hero_image_url: string | null;
      image_urls: string[];
      status: DiscotechVenueStatus;
      city: DiscotechCity | null;
      events: DiscotechEvent[];
      error?: string;
    }>
  > {
    const venues = await this.fetchVenues(params);

    const events = await Promise.all(
      venues.data.map(async (venue) => {
        const citySlug = venue.city?.slug;
        const base = {
          venue_id: venue.id,
          venue_slug: venue.slug,
          city_slug: citySlug ?? '',
          name: venue.name,
          description: venue.description,
          hotel_name: venue.hotel_name,
          hours: venue.hours,
          dress_code: venue.dress_code,
          music: venue.music,
          capacity: venue.capacity,
          price_level: venue.price_level,
          popularity: venue.popularity,
          street_address: venue.street_address,
          zip_code: venue.zip_code,
          full_address: venue.full_address,
          lat: venue.lat,
          lng: venue.lng,
          timezone: venue.timezone,
          google_place_id: venue.google_place_id,
          url: venue.url,
          logo_url: venue.logo_url,
          hero_image_url: venue.hero_image_url,
          image_urls: venue.image_urls,
          status: venue.status,
          city: venue.city ?? null,
        };

        if (!citySlug) {
          return { ...base, events: [], error: 'missing city slug' };
        }
        try {
          const eventsResponse = await this.fetchVenueEvents({
            venue_slug: venue.slug,
            city_slug: citySlug,
          });
          return { ...base, events: eventsResponse.data };
        } catch (error) {
          return {
            ...base,
            events: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    return events;
  }
}
