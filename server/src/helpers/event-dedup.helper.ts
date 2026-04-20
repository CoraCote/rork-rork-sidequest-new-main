import { Injectable } from '@nestjs/common';

export type EventTypeSlug =
  | 'concert'
  | 'sports_event'
  | 'theatre'
  | 'race'
  | 'nightlife'
  | 'festival'
  | 'other_live_event';

const STATE_MAP: Record<string, string> = {
  california: 'ca',
  ca: 'ca',
  'new york': 'ny',
  ny: 'ny',
  nevada: 'nv',
  nv: 'nv',
  illinois: 'il',
  il: 'il',
  texas: 'tx',
  tx: 'tx',
  florida: 'fl',
  fl: 'fl',
  colorado: 'co',
  co: 'co',
  arizona: 'az',
  az: 'az',
  washington: 'wa',
  wa: 'wa',
  oregon: 'or',
  or: 'or',
  'south carolina': 'sc',
  sc: 'sc',
};

const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'live',
  'presented',
  'official',
  'event',
  'tickets',
  'show',
  'night',
  'club',
  'featuring',
  'feat',
  'tour',
  'experience',
  'saturday',
  'friday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
]);

@Injectable()
export class EventDedupHelper {
  normalizeToken(value?: string | null): string {
    if (!value) return '';
    const lowered = value.toLowerCase();
    let out = '';
    for (const ch of lowered) {
      out += /[a-z0-9]/.test(ch) ? ch : ' ';
    }
    return out.trim().split(/\s+/).filter(Boolean).join(' ');
  }

  normalizeStateToken(value?: string | null): string {
    const normalized = this.normalizeToken(value);
    if (!normalized) return '';
    const mapped = STATE_MAP[normalized];
    if (mapped) return mapped;
    const firstToken = normalized.split(' ')[0];
    return STATE_MAP[firstToken] ?? firstToken;
  }

  private sportsMatchupFingerprint(title: string): string | null {
    const normalized = this.normalizeToken(title);
    const separators = [' at ', ' vs ', ' versus ', ' v '];
    for (const sep of separators) {
      const pieces = normalized.split(sep);
      if (pieces.length < 2) continue;
      const left = pieces[0].trim();
      const right = pieces[1].trim();
      if (!left || !right) continue;
      return [left, right].sort().join(' vs ');
    }
    return null;
  }

  dedupeTitleFingerprint(
    title: string,
    eventType: EventTypeSlug,
    venueName?: string | null,
  ): string {
    if (eventType === 'sports_event') {
      const sf = this.sportsMatchupFingerprint(title);
      if (sf) return sf;
    }

    let normalized = this.normalizeToken(title);
    if (venueName) {
      const venueToken = this.normalizeToken(venueName);
      if (venueToken) {
        normalized = normalized.replace(new RegExp(` at ${venueToken}`, 'g'), ' ');
        normalized = normalized.replace(
          new RegExp(` live at ${venueToken}`, 'g'),
          ' ',
        );
      }
    }

    const tokens = normalized
      .split(' ')
      .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t));
    const unique = Array.from(new Set(tokens)).sort();
    const fingerprint = unique.join(' ');
    return fingerprint || normalized;
  }

  localDayToken(
    startLocal?: string | null,
    startAtUTC?: string | Date | null,
    timezone?: string | null,
  ): string {
    if (startLocal) {
      const day = startLocal.split('T')[0];
      if (day) return day;
    }
    if (startAtUTC) {
      const date =
        startAtUTC instanceof Date ? startAtUTC : new Date(startAtUTC);
      if (!Number.isNaN(date.getTime())) {
        try {
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone || 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).formatToParts(date);
          const y = parts.find((p) => p.type === 'year')?.value;
          const m = parts.find((p) => p.type === 'month')?.value;
          const d = parts.find((p) => p.type === 'day')?.value;
          if (y && m && d) return `${y}-${m}-${d}`;
        } catch {
          return date.toISOString().slice(0, 10);
        }
      }
    }
    return 'unknown-day';
  }

  normalizedDedupKey(input: {
    title: string;
    eventType: EventTypeSlug;
    startLocal?: string | null;
    startAtUTC?: string | Date | null;
    timezone?: string | null;
    venueName?: string | null;
    city?: string | null;
    state?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }): string {
    const dayToken = this.localDayToken(
      input.startLocal,
      input.startAtUTC,
      input.timezone,
    );
    const titleToken = this.dedupeTitleFingerprint(
      input.title,
      input.eventType,
      input.venueName,
    );
    const locationBits = [
      input.eventType === 'sports_event' ? '' : this.normalizeToken(input.venueName),
      this.normalizeToken(input.city),
      this.normalizeStateToken(input.state),
      input.latitude != null ? Math.round(input.latitude).toString() : '',
      input.longitude != null ? Math.round(input.longitude).toString() : '',
    ];
    return [titleToken, dayToken, locationBits.join('|')].join('::');
  }

  geohash(lat: number, lng: number, precision = 6): string {
    const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    let minLat = -90,
      maxLat = 90,
      minLng = -180,
      maxLng = 180;
    let bits = 0,
      bit = 0,
      even = true;
    let hash = '';
    while (hash.length < precision) {
      if (even) {
        const mid = (minLng + maxLng) / 2;
        if (lng >= mid) {
          bits = (bits << 1) | 1;
          minLng = mid;
        } else {
          bits = bits << 1;
          maxLng = mid;
        }
      } else {
        const mid = (minLat + maxLat) / 2;
        if (lat >= mid) {
          bits = (bits << 1) | 1;
          minLat = mid;
        } else {
          bits = bits << 1;
          maxLat = mid;
        }
      }
      even = !even;
      if (++bit === 5) {
        hash += base32[bits];
        bits = 0;
        bit = 0;
      }
    }
    return hash;
  }
}
