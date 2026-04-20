import { Injectable, BadRequestException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { NormalizeHelper } from '../../helpers/normalize.helper';
import {
  VenueCacheEntry,
  SnapshotEventMatch,
  ReviewSignal,
  ReviewLookup,
} from '../../utils';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MIN_REVIEW_COUNT_FOR_AGGREGATE_TRUST = 10;
const STRONG_REVIEW_COUNT_THRESHOLD = 50;

@Injectable()
export class DebugService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly normalize: NormalizeHelper,
  ) {}

  // ─── Clear Review Cache ────────────────────────────────────────────

  async clearReviewCache() {
    const { data } = await this.supabase
      .from('venue_review_cache')
      .delete()
      .neq('venue_key', '')
      .select('venue_key');

    return { status: 'cleared', count: Array.isArray(data) ? data.length : 0 };
  }

  // ─── Clear Poisoned Reviews ────────────────────────────────────────

  async clearPoisonedReviews() {
    const { data: poisoned } = await this.supabase
      .from('venue_review_cache')
      .delete()
      .eq('is_poisoned', true)
      .select('venue_key');

    const { data: lowRating } = await this.supabase
      .from('venue_review_cache')
      .delete()
      .lt('google_rating', 3)
      .select('venue_key');

    return {
      status: 'cleared',
      poisoned: Array.isArray(poisoned) ? poisoned.length : 0,
      low_rating: Array.isArray(lowRating) ? lowRating.length : 0,
    };
  }

  // ─── Test Review Scrape ────────────────────────────────────────────

  async testReview(
    venue: string,
    city: string,
    state: string,
    postal?: string,
  ) {
    if (!venue) {
      throw new BadRequestException('venue query param required');
    }

    const result = await this.scrapeVenue(venue, city, state, postal);
    return { venue, city, state, result };
  }

  // ─── Check Venue Rating ────────────────────────────────────────────

  async checkVenueRating(venue: string) {
    const { data: cacheData } = await this.supabase
      .from('venue_review_cache')
      .select(
        'venue_key, venue_name, google_rating, google_review_count, google_maps_url, is_poisoned, poison_reason, fetched_at',
      )
      .ilike('venue_name', `%${venue}%`)
      .limit(10);

    const { data: snapshots } = await this.supabase
      .from('external_event_snapshots')
      .select('cache_key, snapshot')
      .order('fetched_at', { ascending: false })
      .limit(5);

    const matchingEvents: SnapshotEventMatch[] = [];
    if (Array.isArray(snapshots)) {
      for (const snap of snapshots as { cache_key: string; snapshot: any }[]) {
        const events =
          snap.snapshot?.mergedEvents ||
          snap.snapshot?.eventSnapshot?.mergedEvents ||
          [];
        for (const event of events) {
          if (event.venueName?.toLowerCase().includes(venue.toLowerCase())) {
            matchingEvents.push({
              title: event.title,
              venueName: event.venueName,
              venueRating: event.venueRating,
              cacheKey: snap.cache_key,
            });
          }
        }
      }
    }

    return {
      venue,
      cacheEntries: (cacheData as VenueCacheEntry[]) || [],
      snapshotEvents: matchingEvents.slice(0, 10),
    };
  }

  // ─── Raw Event Lookup ──────────────────────────────────────────────

  async getRawEvent(venue: string) {
    const { data: snapshots } = await this.supabase
      .from('external_event_snapshots')
      .select('cache_key, snapshot')
      .order('fetched_at', { ascending: false })
      .limit(2);

    const matchingEvents: any[] = [];
    if (Array.isArray(snapshots)) {
      for (const snap of snapshots as { cache_key: string; snapshot: any }[]) {
        const events = snap.snapshot?.mergedEvents || [];
        for (const event of events) {
          if (event.venueName?.toLowerCase().includes(venue.toLowerCase())) {
            matchingEvents.push({
              title: event.title,
              venueName: event.venueName,
              venueRating: event.venueRating,
              addressLine1: event.addressLine1,
              city: event.city,
              state: event.state,
              postalCode: event.postalCode,
              rawPayloadKeys: Object.keys(
                JSON.parse(event.rawSourcePayload || '{}'),
              ),
              googleRating: JSON.parse(event.rawSourcePayload || '{}')
                .google_places_rating,
              cacheKey: snap.cache_key,
            });
            if (matchingEvents.length >= 3) break;
          }
        }
        if (matchingEvents.length >= 3) break;
      }
    }

    return { matchingEvents };
  }

  // ─── Venue Cache Lookup ────────────────────────────────────────────

  async venueCacheLookup(
    venue: string,
    city: string,
    state: string,
    postal: string,
  ) {
    const venueKey = this.normalize.normalizeToken(venue);
    const cityKey = this.normalize.normalizeToken(city);
    const stateKey = this.normalize.normalizeStateToken(state);
    const postalKey = postal.replace(/\D/g, '').substring(0, 5);

    let key = '';
    if (venueKey && postalKey) {
      key = `venue:${venueKey}|postal:${postalKey}`;
    } else if (venueKey && cityKey && stateKey) {
      key = `venue:${venueKey}|city:${cityKey}|state:${stateKey}`;
    } else {
      key = `venue:${venueKey}`;
    }

    const { data } = await this.supabase
      .from('venue_review_cache')
      .select('*')
      .eq('venue_key', key);

    return { computedKey: key, cacheEntries: data || [] };
  }

  // ─── Scrape and Cache ─────────────────────────────────────────────

  async scrapeAndCache(
    venue: string,
    city: string,
    state: string,
    postal: string,
  ) {
    if (!venue) {
      throw new BadRequestException('venue required');
    }

    const result = await this.scrapeVenue(
      venue,
      city,
      state,
      postal || undefined,
    );
    if (!result || !result.rating) {
      return { error: 'scrape returned no result', result };
    }

    const venueKey = this.normalize.normalizeToken(venue);
    const cityKey = this.normalize.normalizeToken(city);
    const stateKey = this.normalize.normalizeStateToken(state);
    const postalKey = (postal || '').replace(/\D/g, '').substring(0, 5);

    let key = '';
    if (venueKey && postalKey) {
      key = `venue:${venueKey}|postal:${postalKey}`;
    } else if (venueKey && cityKey && stateKey) {
      key = `venue:${venueKey}|city:${cityKey}|state:${stateKey}`;
    } else {
      key = `venue:${venueKey}`;
    }

    const { data: upsertResult } = await this.supabase
      .from('venue_review_cache')
      .upsert(
        {
          venue_key: key,
          venue_name: venue,
          city: city || null,
          state: state || null,
          postal_code: postal || null,
          google_rating: result.rating,
          google_review_count: result.reviewCount,
          google_maps_url: result.url,
          review_source: result.source,
          is_poisoned: false,
          fetched_at: new Date().toISOString(),
          expires_at: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'venue_key' },
      )
      .select();

    return {
      status: 'cached',
      key,
      rating: result.rating,
      reviewCount: result.reviewCount,
      url: result.url,
      upsertResult,
    };
  }

  // ─── Google Review Scraping ────────────────────────────────────────

  private async scrapeVenue(
    venueName: string,
    city: string,
    state: string,
    postalCode?: string,
  ): Promise<ReviewSignal | null> {
    const queryParts = [venueName, city, state, postalCode].filter(
      Boolean,
    ) as string[];
    const query = queryParts.join(' ');
    const reviewURLs = this.buildGoogleReviewURLs(query);

    const lookup: ReviewLookup = {
      cacheKey: `test::${venueName}`,
      venueName,
      city,
      state,
      postalCode,
      query,
      reviewURLs,
    };

    return this.scrapeGoogleReviewSignal(lookup);
  }

  private buildGoogleReviewURLs(query: string): string[] {
    const urls: string[] = [];

    const placeSearchParams = new URLSearchParams({
      hl: 'en',
      gl: 'us',
      q: query + ' reviews',
    });
    urls.push(`https://www.google.com/search?${placeSearchParams.toString()}`);

    const mapSearchParams = new URLSearchParams({
      tbm: 'map',
      authuser: '0',
      hl: 'en',
      gl: 'us',
      q: query,
    });
    urls.push(`https://www.google.com/search?${mapSearchParams.toString()}`);

    const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');
    urls.push(`https://www.google.com/maps/search/${encodedQuery}?hl=en&gl=us`);

    return urls;
  }

  private async scrapeGoogleReviewSignal(
    lookup: ReviewLookup,
  ): Promise<ReviewSignal | null> {
    let htmlSignalResult: ReviewSignal | null = null;
    let mapSignalResult: ReviewSignal | null = null;

    const mapURLs = lookup.reviewURLs.filter((u) => u.includes('tbm=map'));
    const htmlURLs = lookup.reviewURLs.filter((u) => !u.includes('tbm=map'));
    const orderedURLs = [...mapURLs, ...htmlURLs];

    for (const reviewURL of orderedURLs) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 300 * attempt));
          }

          const response = await fetch(reviewURL, {
            method: 'GET',
            headers: {
              'User-Agent': DESKTOP_USER_AGENT,
              'Accept-Language': 'en-US,en;q=0.9',
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              Referer: 'https://www.google.com/',
              DNT: '1',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Site': 'none',
              'Sec-Fetch-User': '?1',
            },
            signal: AbortSignal.timeout(18000),
          });

          if (!response.ok) continue;

          const html = await response.text();
          if (this.isBlockedGoogleResponse(html)) continue;

          if (reviewURL.includes('tbm=map')) {
            const sig = this.parseGoogleMapSearchSignal(html, reviewURL);
            if (
              sig &&
              (!mapSignalResult ||
                (sig.reviewCount ?? 0) > (mapSignalResult.reviewCount ?? 0))
            ) {
              mapSignalResult = sig;
            }
            if (!sig) {
              const fallback = this.parseGoogleHTMLReviewSignal(
                html,
                reviewURL,
              );
              if (
                fallback &&
                (!htmlSignalResult ||
                  (fallback.reviewCount ?? 0) >
                    (htmlSignalResult.reviewCount ?? 0))
              ) {
                htmlSignalResult = fallback;
              }
            }
          } else {
            const sig = this.parseGoogleHTMLReviewSignal(html, reviewURL);
            if (
              sig &&
              (!htmlSignalResult ||
                (sig.reviewCount ?? 0) > (htmlSignalResult.reviewCount ?? 0))
            ) {
              htmlSignalResult = sig;
            }
          }

          if (mapSignalResult) break;
          if (
            htmlSignalResult?.reviewCount &&
            htmlSignalResult.reviewCount >= STRONG_REVIEW_COUNT_THRESHOLD
          ) {
            break;
          }
        } catch {
          continue;
        }
      }

      if (mapSignalResult) break;
      if (
        htmlSignalResult?.reviewCount &&
        htmlSignalResult.reviewCount >= STRONG_REVIEW_COUNT_THRESHOLD
      ) {
        break;
      }
    }

    return this.reconcileSignals(htmlSignalResult, mapSignalResult);
  }

  private isBlockedGoogleResponse(html: string): boolean {
    if (html.length < 3000) return true;
    if (html.includes('unusual traffic') || html.includes('captcha'))
      return true;
    if (html.includes('detected unusual traffic')) return true;
    if (html.includes('<noscript>') && html.includes('enablejs')) return true;
    if (html.includes('httpservice/retry/enablejs')) return true;
    if (html.includes('sorry/index') && html.includes('unusual traffic'))
      return true;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]{0,500})<\/body>/i);
    if (
      bodyMatch?.[1] &&
      bodyMatch[1].replace(/<[^>]*>/g, '').trim().length < 50
    )
      return true;
    return false;
  }

  private parseGoogleMapSearchSignal(
    html: string,
    url: string,
  ): ReviewSignal | null {
    const ratingMatch = html.match(/"(\d\.\d)"[^}]*?"(\d[\d,]*)\s*review/i);
    if (!ratingMatch) return null;

    const rating = parseFloat(ratingMatch[1]);
    const reviewCount = parseInt(ratingMatch[2].replace(/,/g, ''), 10);

    if (isNaN(rating) || rating < 1 || rating > 5) return null;

    return {
      rating,
      reviewCount: isNaN(reviewCount) ? null : reviewCount,
      url,
      source: 'scraped_google_maps',
    };
  }

  private parseGoogleHTMLReviewSignal(
    html: string,
    url: string,
  ): ReviewSignal | null {
    const patterns = [
      /(\d\.\d)\s*(?:out of 5|\/5)?\s*(?:\(|·\s*)(\d[\d,]*)\s*(?:reviews?|ratings?)/i,
      /rating[:\s]*(\d\.\d)[\s\S]{0,50}?(\d[\d,]*)\s*reviews?/i,
      /(\d\.\d)\s*stars?\s*(?:\(|·\s*)(\d[\d,]*)/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const rating = parseFloat(match[1]);
        const reviewCount = parseInt(match[2].replace(/,/g, ''), 10);
        if (rating >= 1 && rating <= 5) {
          return {
            rating,
            reviewCount: isNaN(reviewCount) ? null : reviewCount,
            url,
            source: 'scraped_google_maps',
          };
        }
      }
    }

    return null;
  }

  private reconcileSignals(
    htmlSignal: ReviewSignal | null,
    mapSignal: ReviewSignal | null,
  ): ReviewSignal | null {
    if (!htmlSignal && !mapSignal) return null;
    if (mapSignal && !htmlSignal) return mapSignal;
    if (htmlSignal && !mapSignal) {
      return (htmlSignal.reviewCount ?? 0) >=
        MIN_REVIEW_COUNT_FOR_AGGREGATE_TRUST
        ? htmlSignal
        : null;
    }

    const html = htmlSignal!;
    const map = mapSignal!;
    const htmlCount = html.reviewCount ?? 0;
    const mapCount = map.reviewCount ?? 0;

    if (Math.abs(html.rating - map.rating) <= 0.3) {
      return {
        rating: map.rating,
        reviewCount: Math.max(htmlCount, mapCount) || null,
        url: map.url.includes('/maps/place/')
          ? map.url
          : html.url.includes('/maps/place/')
            ? html.url
            : map.url,
        source: 'scraped_google_maps',
      };
    }

    if (mapCount >= MIN_REVIEW_COUNT_FOR_AGGREGATE_TRUST) return map;
    if (htmlCount >= STRONG_REVIEW_COUNT_THRESHOLD) return html;

    return map.rating > 0 ? map : html;
  }
}
