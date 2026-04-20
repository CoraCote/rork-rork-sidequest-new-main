import { Injectable } from '@nestjs/common';
import { NormalizeHelper } from './normalize.helper';
import {
  EventResult,
  MetroRecord,
  BuiltSnapshot,
  SnapshotEvent,
} from '../utils';

@Injectable()
export class SnapshotBuilderHelper {
  constructor(private readonly normalize: NormalizeHelper) {}

  buildSnapshot(
    metro: MetroRecord,
    intent: string,
    eventsBySource: Map<string, EventResult[]>,
    notes: string[],
  ): BuiltSnapshot {
    const now = new Date().toISOString();

    const allEvents: EventResult[] = [];
    for (const events of eventsBySource.values()) {
      allEvents.push(...events);
    }

    const deduped = this.deduplicateEvents(allEvents);
    const snapshotEvents = deduped.events.map((e) => this.toSnapshotEvent(e));

    snapshotEvents.sort((a, b) => {
      const aDate = a.startAtUTC || '9999';
      const bDate = b.startAtUTC || '9999';
      return aDate.localeCompare(bDate);
    });

    const sourceResults = Array.from(eventsBySource.entries()).map(
      ([source, events]) => ({
        source,
        usedCache: false,
        fetchedAt: now,
        endpoints: [
          {
            label: `${source} server fetch`,
            requestURL: `server://${source}`,
            responseStatusCode: 200 as number | null,
            worked: events.length > 0,
            note: null as string | null,
          },
        ],
        note:
          events.length === 0
            ? `${source}: no events returned`
            : (null as string | null),
        nextCursor: null,
        events: events.map((e) => this.toSnapshotEvent(e)),
      }),
    );

    return {
      fetchedAt: now,
      searchLocation: {
        city: metro.city ?? '',
        state: metro.state ?? '',
        postalCode: metro.postal_code ?? null,
        countryCode: metro.country_code ?? 'US',
        latitude: metro.latitude,
        longitude: metro.longitude,
        displayName: metro.display_name,
      },
      appliedProfiles: [
        {
          step: 0,
          hyperlocalRadiusMiles: 2,
          nightlifeRadiusMiles: 6,
          headlineRadiusMiles: 15,
        },
      ],
      venueSnapshot: null,
      eventSnapshot: {
        fetchedAt: now,
        query: {
          countryCode: metro.country_code ?? 'US',
          city: metro.city ?? '',
          state: metro.state ?? '',
          postalCode: metro.postal_code ?? null,
          latitude: metro.latitude,
          longitude: metro.longitude,
          radiusMiles: 15,
          pageSize: 50,
          page: 0,
          sourcePageDepth: 2,
          includePast: false,
          hyperlocalRadiusMiles: 2,
          nightlifeRadiusMiles: 6,
          headlineRadiusMiles: 15,
          adaptiveRadiusExpansion: true,
          discoveryIntent: intent,
        },
        sourceResults,
        mergedEvents: snapshotEvents,
        dedupeGroups: deduped.groups,
      },
      mergedEvents: snapshotEvents,
      notes,
    };
  }

  private deduplicateEvents(events: EventResult[]): {
    events: EventResult[];
    groups: Array<{
      dedupeKey: string;
      canonicalEventID: string;
      mergedEventIDs: string[];
      mergedSources: string[];
      reason: string;
    }>;
  } {
    const buckets = new Map<string, EventResult[]>();

    for (const event of events) {
      const key = this.normalize.dedupeBucketKey(event);
      const bucket = buckets.get(key) || [];
      bucket.push(event);
      buckets.set(key, bucket);
    }

    const deduped: EventResult[] = [];
    const groups: Array<{
      dedupeKey: string;
      canonicalEventID: string;
      mergedEventIDs: string[];
      mergedSources: string[];
      reason: string;
    }> = [];

    for (const [bucketKey, bucketEvents] of buckets) {
      const clusters: EventResult[][] = [];

      for (const event of bucketEvents) {
        let placed = false;
        for (const cluster of clusters) {
          if (cluster.some((e) => this.normalize.isLikelyDuplicate(e, event))) {
            cluster.push(event);
            placed = true;
            break;
          }
        }
        if (!placed) clusters.push([event]);
      }

      for (const cluster of clusters) {
        cluster.sort(
          (a, b) => this.completenessScore(b) - this.completenessScore(a),
        );
        const canonical = cluster[0];
        deduped.push(canonical);

        if (cluster.length > 1) {
          groups.push({
            dedupeKey: bucketKey,
            canonicalEventID: canonical.id,
            mergedEventIDs: cluster.map((e) => e.id),
            mergedSources: [...new Set(cluster.map((e) => e.source))],
            reason: 'Server-side dedup: shared day, fuzzy title, venue overlap',
          });
        }
      }
    }

    return { events: deduped, groups };
  }

  private completenessScore(event: EventResult): number {
    let score = 0;
    if (event.latitude && event.longitude) score += 6;
    if (event.startAtUTC) score += 5;
    if (event.timezone) score += 3;
    if (event.venueName) score += 3;
    if (event.addressLine1) score += 4;
    if (event.city) score += 2;
    if (event.imageUrl) score += 4;
    if (event.shortDescription) score += 2;
    if (event.ticketUrl) score += 2;
    const rating = this.normalize.sanitizeReviewRating(
      event.rawSourcePayload?.google_places_rating,
    );
    if (rating) score += 3;
    const count = this.normalize.sanitizeReviewCount(
      event.rawSourcePayload?.google_places_user_rating_count,
    );
    if (count) score += 2;
    return score;
  }

  private toSnapshotEvent(event: EventResult): SnapshotEvent {
    const rating = this.normalize.sanitizeReviewRating(
      event.rawSourcePayload?.google_places_rating,
    );
    const reviewCount = this.normalize.sanitizeReviewCount(
      event.rawSourcePayload?.google_places_user_rating_count,
    );

    return {
      id: event.id,
      source: event.source,
      sourceEventID: event.sourceEventId,
      sourceParentID: event.sourceParentId,
      sourceURL: event.sourceUrl,
      mergedSources: [event.source],
      title: event.title,
      shortDescription: event.shortDescription,
      fullDescription: event.fullDescription,
      category: event.category,
      subcategory: event.subcategory,
      eventType: event.eventType,
      startAtUTC: event.startAtUTC,
      endAtUTC: event.endAtUTC,
      startLocal: event.startLocal,
      endLocal: event.endLocal,
      timezone: event.timezone,
      venueName: event.venueName,
      venueID: event.venueId,
      addressLine1: event.addressLine1,
      city: event.city,
      state: event.state,
      postalCode: event.postalCode,
      country: event.country,
      latitude: event.latitude,
      longitude: event.longitude,
      imageURL: event.imageUrl,
      status: event.status || 'scheduled',
      availabilityStatus: event.status === 'onsale' ? 'onsale' : 'unknown',
      tags: event.tags || [],
      priceMin: event.priceMin,
      priceMax: event.priceMax,
      currency: event.currency,
      ticketURL: event.ticketUrl,
      rawSourcePayload: JSON.stringify(event.rawSourcePayload || {}),
      sourceType: this.sourceTypeFor(event.source),
      recordKind: 'event',
      artistsOrTeams: [],
      venueRating: rating ?? undefined,
      venuePopularityCount: reviewCount ?? undefined,
    };
  }

  private sourceTypeFor(source: string): string {
    switch (source) {
      case 'ticketmaster':
      case 'seatGeek':
      case 'stubHub':
      case 'eventbrite':
        return 'ticketing_api';
      case 'googleEvents':
        return 'scraped';
      case 'appleMaps':
      case 'googlePlaces':
      case 'yelpFusion':
        return 'venue_discovery_api';
      default:
        return 'scraped';
    }
  }
}
