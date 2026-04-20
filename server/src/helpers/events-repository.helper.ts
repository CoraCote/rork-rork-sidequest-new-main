import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SupabaseClient } from '@supabase/supabase-js';
import { NormalizedEvent, EventSource } from './event-normalizer.helper';

const SOURCE_PRIORITY: Record<EventSource, number> = {
  ticketmaster: 100,
  eventbrite: 90,
  discotech: 80,
  clubbable: 60,
  runsignup: 50,
};

type EventRow = NormalizedEvent & {
  id: string;
  merged_into: string | null;
  merged_sources: string[];
};

@Injectable()
export class EventsRepositoryHelper {
  constructor(
    private readonly supabase: SupabaseClient,
    @InjectPinoLogger(EventsRepositoryHelper.name)
    private readonly logger: PinoLogger,
  ) {}

  async upsertAndMerge(events: NormalizedEvent[]): Promise<{
    inserted: number;
    merged: number;
    skipped: number;
  }> {
    if (events.length === 0) return { inserted: 0, merged: 0, skipped: 0 };

    let inserted = 0;
    let merged = 0;
    let skipped = 0;

    const batchSize = 100;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      const rows = batch.map((e) => this.toRow(e));

      const { data, error } = await this.supabase
        .from('events')
        .upsert(rows, {
          onConflict: 'source,source_event_id',
          ignoreDuplicates: false,
        })
        .select('id, dedup_hash, source, merged_into, merged_sources');

      if (error) {
        this.logger.error(
          { err: error, batchSize: batch.length },
          'events upsert failed',
        );
        skipped += batch.length;
        continue;
      }
      inserted += data?.length ?? 0;
    }

    // Second pass: cross-source merge by dedup_hash.
    // Keep slice size small — dedup hashes are long, and PostgREST passes
    // `.in(...)` values via URL query, so big batches overflow the 16KB
    // header limit.
    const uniqueHashes = Array.from(new Set(events.map((e) => e.dedup_hash)));
    const mergeBatch = 25;
    for (let i = 0; i < uniqueHashes.length; i += mergeBatch) {
      const slice = uniqueHashes.slice(i, i + mergeBatch);
      const mergedCount = await this.mergeHashes(slice);
      merged += mergedCount;
    }

    this.logger.info({ inserted, merged, skipped }, 'events upsert+merge');
    return { inserted, merged, skipped };
  }

  private async mergeHashes(hashes: string[]): Promise<number> {
    if (hashes.length === 0) return 0;
    const { data, error } = await this.supabase
      .from('events')
      .select('*')
      .in('dedup_hash', hashes)
      .is('merged_into', null);

    if (error || !data) {
      this.logger.error({ err: error }, 'mergeHashes select failed');
      return 0;
    }

    const byHash = new Map<string, EventRow[]>();
    for (const row of data as EventRow[]) {
      const bucket = byHash.get(row.dedup_hash) ?? [];
      bucket.push(row);
      byHash.set(row.dedup_hash, bucket);
    }

    let mergedCount = 0;
    for (const [, rows] of byHash) {
      if (rows.length < 2) continue;
      const sorted = [...rows].sort(
        (a, b) =>
          (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0),
      );
      const winner = sorted[0];
      const losers = sorted.slice(1);

      const mergedSources = Array.from(
        new Set([
          ...(winner.merged_sources ?? []),
          ...losers.map((l) => l.source),
        ]),
      );

      const enriched = this.fillMissing(winner, losers);

      const { error: winnerErr } = await this.supabase
        .from('events')
        .update({ ...enriched, merged_sources: mergedSources })
        .eq('id', winner.id);
      if (winnerErr) {
        this.logger.error({ err: winnerErr }, 'merge winner update failed');
        continue;
      }

      const { error: losersErr } = await this.supabase
        .from('events')
        .update({ merged_into: winner.id })
        .in(
          'id',
          losers.map((l) => l.id),
        );
      if (losersErr) {
        this.logger.error({ err: losersErr }, 'merge losers update failed');
        continue;
      }
      mergedCount += losers.length;
    }
    return mergedCount;
  }

  private fillMissing(
    winner: EventRow,
    losers: EventRow[],
  ): Partial<EventRow> {
    const patch: Record<string, unknown> = {};
    const fields: (keyof EventRow)[] = [
      'short_description',
      'full_description',
      'category',
      'subcategory',
      'image_url',
      'price_min',
      'price_max',
      'currency',
      'dress_code_text' as keyof EventRow,
      'opening_hours_text',
      'venue_rating',
      'venue_popularity_count',
      'age_minimum',
      'organizer_name',
      'registration_url',
      'reservation_url',
      'ticket_url',
    ];
    for (const field of fields) {
      const winnerValue = (winner as unknown as Record<string, unknown>)[
        field as string
      ];
      if (winnerValue != null && winnerValue !== '') continue;
      for (const loser of losers) {
        const loserValue = (loser as unknown as Record<string, unknown>)[
          field as string
        ];
        if (loserValue != null && loserValue !== '') {
          patch[field as string] = loserValue;
          break;
        }
      }
    }
    return patch as Partial<EventRow>;
  }

  async queryViewport(input: {
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
    startAfterUTC?: string | null;
    limit?: number;
  }): Promise<{
    mode: 'points';
    points: MapPoint[];
  }> {
    const limit = Math.min(input.limit ?? 400, 1000);

    let query = this.supabase
      .from('events')
      .select(
        'id, source, title, event_type, category, subcategory, image_url, latitude, longitude, geohash, start_at_utc, start_local, timezone, venue_name, city, state, price_min, price_max, currency, ticket_url, reservation_url, registration_url, source_url, merged_sources',
      )
      .is('merged_into', null)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .gte('latitude', input.minLat)
      .lte('latitude', input.maxLat)
      .gte('longitude', input.minLng)
      .lte('longitude', input.maxLng)
      .limit(limit);

    if (input.startAfterUTC) {
      query = query.gte('start_at_utc', input.startAfterUTC);
    }

    const { data, error } = await query;
    if (error) {
      this.logger.error({ err: error }, 'viewport query failed');
      return { mode: 'points', points: [] };
    }

    const rows = (data ?? []) as ViewportRow[];
    const points: MapPoint[] = rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      event_type: r.event_type,
      category: r.category,
      subcategory: r.subcategory,
      image_url: r.image_url,
      latitude: r.latitude!,
      longitude: r.longitude!,
      start_at_utc: r.start_at_utc,
      start_local: r.start_local,
      timezone: r.timezone,
      venue_name: r.venue_name,
      city: r.city,
      state: r.state,
      price_min: r.price_min,
      price_max: r.price_max,
      currency: r.currency,
      url:
        r.ticket_url ??
        r.reservation_url ??
        r.registration_url ??
        r.source_url ??
        null,
      merged_sources: r.merged_sources ?? [],
    }));

    return { mode: 'points', points };
  }

  private toRow(e: NormalizedEvent): Record<string, unknown> {
    return { ...e };
  }
}

interface ViewportRow {
  id: string;
  source: EventSource;
  title: string;
  event_type: string;
  category: string | null;
  subcategory: string | null;
  image_url: string | null;
  latitude: number | null;
  longitude: number | null;
  start_at_utc: string | null;
  start_local: string | null;
  timezone: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  ticket_url: string | null;
  reservation_url: string | null;
  registration_url: string | null;
  source_url: string | null;
  merged_sources: string[] | null;
}

export interface MapPoint {
  id: string;
  source: EventSource;
  title: string;
  event_type: string;
  category: string | null;
  subcategory: string | null;
  image_url: string | null;
  latitude: number;
  longitude: number;
  start_at_utc: string | null;
  start_local: string | null;
  timezone: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  url: string | null;
  merged_sources: string[];
}

export interface MapCluster {
  geohash: string;
  count: number;
  latitude: number;
  longitude: number;
  sample: MapPoint;
}
