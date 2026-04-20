import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import {
  AdapterResult,
  EventResult,
  MetroRecord,
  RunSignupListResponse,
  RunSignupDetailResponse,
  httpClient,
} from '../utils';
import { RunSignupSearchDto } from '../dtos';

@Injectable()
export class RunSignupHelper {
  async fetchRunSignup(
    metro: MetroRecord,
    intent: string,
  ): Promise<AdapterResult> {
    const result: AdapterResult = {
      source: 'runsignup',
      events: [],
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      avgLatencyMs: 0,
      notes: [],
    };

    const listUrl = new URL('https://api.runsignup.com/rest/races');
    listUrl.searchParams.set('format', 'json');
    listUrl.searchParams.set(
      'results_per_page',
      String(this.limitForIntent(intent)),
    );
    listUrl.searchParams.set('page', '1');
    listUrl.searchParams.set('start_date', 'today');
    listUrl.searchParams.set('sort', 'date ASC');

    if (metro.postal_code) {
      listUrl.searchParams.set('zipcode', metro.postal_code);
      listUrl.searchParams.set(
        'radius',
        intent === 'biggest_tonight' ? '50' : '35',
      );
    } else {
      listUrl.searchParams.set('city', metro.city ?? '');
      listUrl.searchParams.set('state', metro.state ?? '');
    }

    const latencies: number[] = [];
    const listResponse =
      await this.fetchJsonWithTracking<RunSignupListResponse>(
        listUrl,
        result,
        latencies,
      );
    if (!listResponse?.races?.length) {
      if (result.notes.length === 0) {
        result.notes.push('RunSignup returned no local races');
      }
      this.finalizeLatency(result, latencies);
      return result;
    }

    const raceIds = listResponse.races
      .map((entry) => entry.race?.race_id)
      .filter((value): value is number => typeof value === 'number')
      .slice(0, this.limitForIntent(intent));

    const settled = await Promise.allSettled(
      raceIds.map(async (raceId) => {
        const detailUrl = new URL(
          `https://api.runsignup.com/rest/race/${raceId}`,
        );
        detailUrl.searchParams.set('format', 'json');
        const detail =
          await this.fetchJsonWithTracking<RunSignupDetailResponse>(
            detailUrl,
            result,
            latencies,
          );
        if (!detail?.race?.events?.length) return [];
        return detail.race.events
          .map((event) => this.normalizeRunSignupEvent(detail.race!, event))
          .filter((event): event is EventResult => event !== null);
      }),
    );

    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        result.events.push(...entry.value);
      } else {
        result.failureCount++;
        result.notes.push(`RunSignup detail error: ${String(entry.reason)}`);
      }
    }

    result.events = this.dedupeEvents(result.events);
    this.finalizeLatency(result, latencies);
    return result;
  }

  private limitForIntent(intent: string): number {
    switch (intent) {
      case 'biggest_tonight':
        return 10;
      case 'last_minute_plans':
        return 8;
      default:
        return 6;
    }
  }

  private async fetchJsonWithTracking<T>(
    url: URL,
    result: AdapterResult,
    latencies: number[],
  ): Promise<T | null> {
    result.requestCount++;
    const startedAt = Date.now();

    try {
      const response = await httpClient.get<T>(url.toString(), {
        headers: { Accept: 'application/json' },
      });

      latencies.push(Date.now() - startedAt);

      if (response.status < 200 || response.status >= 300) {
        result.failureCount++;
        result.notes.push(`RunSignup ${url.pathname}: HTTP ${response.status}`);
        return null;
      }

      result.successCount++;
      return response.data;
    } catch (error) {
      latencies.push(Date.now() - startedAt);
      const isTimeout = (error as { code?: string })?.code === 'ECONNABORTED';
      if (isTimeout) {
        result.timeoutCount++;
        result.notes.push(`RunSignup ${url.pathname}: timeout`);
      } else {
        result.failureCount++;
        result.notes.push(`RunSignup ${url.pathname}: ${String(error)}`);
      }
      return null;
    }
  }

  private normalizeRunSignupEvent(
    race: NonNullable<RunSignupDetailResponse['race']>,
    event: NonNullable<
      NonNullable<RunSignupDetailResponse['race']>['events']
    >[number],
  ): EventResult | null {
    if (!race.race_id || !event.event_id || !event.name || !event.start_time) {
      return null;
    }

    const eventType = this.classifyRunEvent(
      event.name,
      event.distance,
      event.event_type,
    );
    if (eventType === 'other live event') return null;

    const raceName = race.name || 'RunSignup Event';
    const timezone = race.timezone || undefined;
    const startAtUTC = this.localRunSignupDateToUTC(event.start_time, timezone);
    const endAtUTC = event.end_time
      ? this.localRunSignupDateToUTC(event.end_time, timezone)
      : undefined;
    if (startAtUTC) {
      const startMs = new Date(startAtUTC).getTime();
      const now = Date.now();
      if (startMs < now - 12 * 60 * 60 * 1000) return null;
      if (startMs > now + 400 * 24 * 60 * 60 * 1000) return null;
    }
    const price = this.extractRunSignupPrice(event.registration_periods);

    const addressParts = [race.address?.street, race.address?.street2].filter(
      Boolean,
    );

    return {
      id: `runsignup:${race.race_id}:${event.event_id}`,
      source: 'runsignup',
      sourceEventId: String(event.event_id),
      sourceParentId: String(race.race_id),
      sourceUrl: race.url,
      title: `${raceName}${event.name.toLowerCase() === raceName.toLowerCase() ? '' : ` - ${event.name}`}`,
      shortDescription: this.shorten(
        this.htmlToText(event.details || race.description || ''),
      ),
      fullDescription: this.htmlToText(event.details || race.description || ''),
      category: 'fitness',
      subcategory: event.distance || event.event_type || undefined,
      eventType,
      startAtUTC,
      endAtUTC,
      startLocal: this.toIsoLocalLike(event.start_time),
      endLocal: event.end_time
        ? this.toIsoLocalLike(event.end_time)
        : undefined,
      timezone,
      venueName: raceName,
      venueId: String(race.race_id),
      addressLine1: addressParts.join(', ') || undefined,
      city: race.address?.city || undefined,
      state: race.address?.state || undefined,
      postalCode: race.address?.zipcode || undefined,
      country: race.address?.country_code || 'US',
      imageUrl: race.logo_url || undefined,
      status: race.is_registration_open === 'T' ? 'onsale' : 'scheduled',
      priceMin: price ?? undefined,
      priceMax: price ?? undefined,
      currency: price != null ? 'USD' : undefined,
      ticketUrl: race.url,
      tags: [event.distance, event.event_type].filter(
        (value): value is string => Boolean(value),
      ),
      rawSourcePayload: {
        runsignup_race_id: race.race_id,
        runsignup_event_id: event.event_id,
        runsignup_distance: event.distance,
        runsignup_registration_open: race.is_registration_open === 'T',
      },
    };
  }

  private classifyRunEvent(
    name?: string,
    distance?: string,
    eventType?: string,
  ): string {
    const haystack =
      `${name || ''} ${distance || ''} ${eventType || ''}`.toLowerCase();
    if (
      haystack.includes('5k') ||
      haystack.includes('10k') ||
      haystack.includes('half') ||
      haystack.includes('marathon') ||
      haystack.includes('mile') ||
      haystack.includes('running')
    ) {
      return 'weekend activity';
    }
    return 'other live event';
  }

  private extractRunSignupPrice(
    periods?: Array<{ race_fee?: string }>,
  ): number | null {
    for (const period of periods || []) {
      if (!period.race_fee) continue;
      const numeric = parseFloat(period.race_fee.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
    return null;
  }

  private localRunSignupDateToUTC(
    value: string,
    timeZone?: string,
  ): string | undefined {
    const match = value.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/,
    );
    if (!match) return undefined;

    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);

    if (!timeZone) {
      return new Date(year, month - 1, day, hour, minute).toISOString();
    }

    return this.zonedTimeToUTC(year, month, day, hour, minute, timeZone);
  }

  private zonedTimeToUTC(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string,
  ): string {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(utcGuess);
    const partMap = Object.fromEntries(
      parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    const zonedAsUtc = Date.UTC(
      parseInt(partMap.year, 10),
      parseInt(partMap.month, 10) - 1,
      parseInt(partMap.day, 10),
      parseInt(partMap.hour, 10),
      parseInt(partMap.minute, 10),
    );

    return new Date(
      utcGuess.getTime() - (zonedAsUtc - utcGuess.getTime()),
    ).toISOString();
  }

  private toIsoLocalLike(value: string): string | undefined {
    const match = value.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/,
    );
    if (!match) return undefined;
    const month = match[1].padStart(2, '0');
    const day = match[2].padStart(2, '0');
    const year = match[3];
    const hour = match[4].padStart(2, '0');
    const minute = match[5].padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}:00`;
  }

  private shorten(value: string, maxLength: number = 200): string | undefined {
    if (!value) return undefined;
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3).trim()}...`;
  }

  private dedupeEvents(events: EventResult[]): EventResult[] {
    const seen = new Set<string>();
    const deduped: EventResult[] = [];
    for (const event of events) {
      const key = [
        event.title,
        event.startAtUTC || event.startLocal,
        event.venueName,
      ]
        .filter(Boolean)
        .join('::')
        .toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }
    return deduped;
  }

  private finalizeLatency(result: AdapterResult, latencies: number[]): void {
    result.avgLatencyMs =
      latencies.length > 0
        ? Math.round(
            latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
          )
        : 0;
  }

  async searchRaces(
    params: RunSignupSearchDto = {},
  ): Promise<RunSignupListResponse> {
    const url = new URL('https://api.runsignup.com/rest/races');
    url.searchParams.set('format', 'json');
    url.searchParams.set('events', 'T');
    url.searchParams.set('race_headings', 'T');
    url.searchParams.set('race_links', 'T');
    url.searchParams.set('include_event_days', 'T');
    url.searchParams.set('include_extra_date_info', 'T');
    url.searchParams.set('include_giveaway_details', 'T');
    url.searchParams.set(
      'results_per_page',
      String(params.results_per_page ?? 25),
    );
    url.searchParams.set('page', String(params.page ?? 1));
    url.searchParams.set('sort', params.sort ?? 'date ASC');
    url.searchParams.set('start_date', params.start_date ?? 'today');

    const optionalKeys: Array<Extract<keyof RunSignupSearchDto, string>> = [
      'name',
      'end_date',
      'created_since',
      'created_on_or_before',
      'modified_since',
      'modified_on_or_before',
      'only_partner_races',
      'search_start_date_only',
      'only_races_with_results',
      'city',
      'state',
      'country',
      'event_type',
      'min_distance',
      'max_distance',
      'distance_units',
      'zipcode',
      'radius',
    ];
    for (const key of optionalKeys) {
      const value = params[key];
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const response = await httpClient.get<RunSignupListResponse>(
      url.toString(),
      { headers: { Accept: 'application/json' } },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`RunSignup races HTTP ${response.status}`);
    }
    const data = response.data;
    for (const entry of data.races ?? []) {
      if (entry.race?.description) {
        entry.race.description = this.htmlToText(entry.race.description);
      }
    }
    return data;
  }

  async getRaceDetail(
    raceId: number | string,
  ): Promise<RunSignupDetailResponse> {
    const url = new URL(`https://api.runsignup.com/rest/race/${raceId}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('future_events_only', 'T');
    url.searchParams.set('race_headings', 'T');
    url.searchParams.set('race_links', 'T');
    url.searchParams.set('include_waiver', 'T');
    url.searchParams.set('include_multiple_waivers', 'T');
    url.searchParams.set('include_participant_caps', 'T');
    url.searchParams.set('include_age_based_pricing', 'T');
    url.searchParams.set('include_giveaway_details', 'T');
    url.searchParams.set('include_questions', 'T');
    url.searchParams.set('include_addons', 'T');
    url.searchParams.set('include_membership_settings', 'T');
    url.searchParams.set('include_corral_settings', 'T');
    url.searchParams.set('include_donation_settings', 'T');
    url.searchParams.set('include_extra_date_info', 'T');
    url.searchParams.set('supports_question_application_types', 'T');

    const response = await httpClient.get<RunSignupDetailResponse>(
      url.toString(),
      { headers: { Accept: 'application/json' } },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`RunSignup race HTTP ${response.status}`);
    }
    const data = response.data;
    if (data.race?.description) {
      data.race.description = this.htmlToText(data.race.description);
    }
    return data;
  }

  private htmlToText(html: string): string {
    return cheerio.load(html).text().trim();
  }

  async searchRacesWithDetails(params: RunSignupSearchDto = {}): Promise<{
    list: RunSignupListResponse;
    details: Array<
      | { race_id: number; detail: RunSignupDetailResponse }
      | { race_id: number; error: string }
    >;
    events: EventResult[];
  }> {
    const list = await this.searchRaces(params);
    const raceIds = (list.races ?? [])
      .map((entry) => entry.race?.race_id)
      .filter((id): id is number => typeof id === 'number');

    const details = await Promise.all(
      raceIds.map(async (race_id) => {
        try {
          const detail = await this.getRaceDetail(race_id);
          return { race_id, detail };
        } catch (error) {
          return {
            race_id,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const normalized: EventResult[] = [];
    for (const entry of details) {
      if (!('detail' in entry) || !entry.detail) continue;
      const race = entry.detail.race;
      if (!race?.events?.length) continue;
      for (const event of race.events) {
        const normalizedEvent = this.normalizeRunSignupEvent(race, event);
        if (normalizedEvent) normalized.push(normalizedEvent);
      }
    }

    return {
      list,
      details,
      events: this.dedupeEvents(normalized),
    };
  }
}
