import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { SupabaseClient } from '@supabase/supabase-js';
import { httpClient } from '../utils';

export interface NominatimNameDetails {
  name?: string;
  'name:en'?: string;
  [key: string]: string | undefined;
}

export interface NominatimAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  'ISO3166-2-lvl4'?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

export interface NominatimSearchResult {
  place_id: number;
  licence: string;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  category: string;
  type: string;
  place_rank: number;
  importance: number;
  addresstype: string;
  name: string;
  display_name: string;
  boundingbox: [string, string, string, string];
  namedetails?: NominatimNameDetails;
  address?: NominatimAddress;
}

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName: string;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  raw: NominatimSearchResult | null;
}

interface GeocodeCacheRow {
  query_hash: string;
  query_text: string;
  provider: string;
  latitude: number | null;
  longitude: number | null;
  display_name: string | null;
  house_number: string | null;
  road: string | null;
  neighbourhood: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  country_code: string | null;
  osm_type: string | null;
  osm_id: number | null;
  place_id: number | null;
  place_rank: number | null;
  importance: number | null;
  bbox: number[] | null;
  raw: Record<string, unknown>;
}

@Injectable()
export class OsmHelper {
  private readonly baseUrl = 'https://nominatim.openstreetmap.org';
  private readonly userAgent = 'SideQuest/1.0 (events-ingestion)';
  private readonly minRequestSpacingMs = 1100;
  private readonly tableName = 'geocode_cache';
  private nextRequestAt = 0;
  private requestCount = 0;
  private cacheHits = 0;
  private readonly memoryCache = new Map<string, GeocodeResult | null>();

  constructor(
    private readonly supabase: SupabaseClient,
    @InjectPinoLogger(OsmHelper.name)
    private readonly logger: PinoLogger,
  ) {}

  async geocode(query: string): Promise<GeocodeResult | null> {
    const queryText = query.trim();
    if (!queryText) return null;
    const key = this.hashQuery(queryText);

    if (this.memoryCache.has(key)) {
      this.cacheHits++;
      return this.memoryCache.get(key) ?? null;
    }

    const cached = await this.readCache(key);
    if (cached !== undefined) {
      this.memoryCache.set(key, cached);
      this.cacheHits++;
      this.touchCache(key).catch(() => undefined);
      return cached;
    }

    const results = await this.search(queryText);
    const first = results[0] ?? null;
    const parsed = first ? this.toResult(first) : null;
    this.memoryCache.set(key, parsed);
    await this.writeCache(key, queryText, parsed, first);
    return parsed;
  }

  async geocodeAddress(parts: {
    street?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  }): Promise<GeocodeResult | null> {
    const query = [
      parts.street,
      parts.city,
      parts.state,
      parts.postalCode,
      parts.country,
    ]
      .filter((v): v is string => Boolean(v && v.trim()))
      .join(', ');
    if (!query) return null;
    return this.geocode(query);
  }

  async search(query: string): Promise<NominatimSearchResult[]> {
    await this.throttle();
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', query);
    url.searchParams.set('namedetails', '1');
    url.searchParams.set('entrances', '1');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '5');

    try {
      const response = await httpClient.get<NominatimSearchResult[]>(
        url.toString(),
        {
          headers: {
            Accept: 'application/json',
            'User-Agent': this.userAgent,
            'Accept-Language': 'en',
          },
        },
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Nominatim HTTP ${response.status}`);
      }
      return response.data ?? [];
    } catch (error) {
      this.logger.warn(
        { err: error, query },
        'Nominatim geocode request failed',
      );
      return [];
    }
  }

  private hashQuery(query: string): string {
    const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex');
  }

  private async readCache(
    queryHash: string,
  ): Promise<GeocodeResult | null | undefined> {
    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select('*')
        .eq('query_hash', queryHash)
        .maybeSingle();
      if (error) {
        this.logger.warn({ err: error }, 'geocode cache read failed');
        return undefined;
      }
      if (!data) return undefined;
      return this.rowToResult(data as GeocodeCacheRow);
    } catch (err) {
      this.logger.warn({ err }, 'geocode cache read threw');
      return undefined;
    }
  }

  private rowToResult(row: GeocodeCacheRow): GeocodeResult | null {
    if (row.latitude == null || row.longitude == null) return null;
    return {
      latitude: row.latitude,
      longitude: row.longitude,
      displayName: row.display_name ?? '',
      city: row.city ?? null,
      state: row.state ?? null,
      postalCode: row.postal_code ?? null,
      country: row.country_code ?? row.country ?? null,
      raw: (row.raw as unknown as NominatimSearchResult) ?? null,
    };
  }

  private async writeCache(
    queryHash: string,
    queryText: string,
    parsed: GeocodeResult | null,
    first: NominatimSearchResult | null,
  ): Promise<void> {
    const address = first?.address ?? {};
    const row: Partial<GeocodeCacheRow> = {
      query_hash: queryHash,
      query_text: queryText,
      provider: 'nominatim',
      latitude: parsed?.latitude ?? null,
      longitude: parsed?.longitude ?? null,
      display_name: parsed?.displayName ?? null,
      house_number: address.house_number ?? null,
      road: address.road ?? null,
      neighbourhood: address.neighbourhood ?? address.suburb ?? null,
      city:
        address.city ??
        address.town ??
        address.village ??
        address.municipality ??
        null,
      county: address.county ?? null,
      state: address.state ?? null,
      postal_code: address.postcode ?? null,
      country: address.country ?? null,
      country_code: address.country_code?.toUpperCase() ?? null,
      osm_type: first?.osm_type ?? null,
      osm_id: first?.osm_id ?? null,
      place_id: first?.place_id ?? null,
      place_rank: first?.place_rank ?? null,
      importance: first?.importance ?? null,
      bbox: first?.boundingbox
        ? first.boundingbox.map((v) => parseFloat(v))
        : null,
      raw: (first as unknown as Record<string, unknown>) ?? {},
    };

    try {
      const { error } = await this.supabase
        .from(this.tableName)
        .upsert(row, { onConflict: 'query_hash' });
      if (error) {
        this.logger.warn({ err: error }, 'geocode cache write failed');
      }
    } catch (err) {
      this.logger.warn({ err }, 'geocode cache write threw');
    }
  }

  private async touchCache(queryHash: string): Promise<void> {
    try {
      await this.supabase.rpc('geocode_cache_touch', { p_hash: queryHash });
    } catch {
      // best-effort; the RPC is optional — fall back to direct update
      try {
        await this.supabase
          .from(this.tableName)
          .update({ last_used_at: new Date().toISOString() })
          .eq('query_hash', queryHash);
      } catch {
        /* swallow */
      }
    }
  }

  private toResult(entry: NominatimSearchResult): GeocodeResult | null {
    const lat = parseFloat(entry.lat);
    const lng = parseFloat(entry.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const address = entry.address ?? {};
    return {
      latitude: lat,
      longitude: lng,
      displayName: entry.display_name,
      city:
        address.city ??
        address.town ??
        address.village ??
        address.municipality ??
        null,
      state: address.state ?? null,
      postalCode: address.postcode ?? null,
      country: address.country_code?.toUpperCase() ?? address.country ?? null,
      raw: entry,
    };
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.nextRequestAt - now;
    this.nextRequestAt =
      Math.max(now, this.nextRequestAt) + this.minRequestSpacingMs;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    this.requestCount++;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  getCacheHitCount(): number {
    return this.cacheHits;
  }
}
