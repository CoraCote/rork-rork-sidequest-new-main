import { Injectable } from '@nestjs/common';

const STATE_MAP: Record<string, string> = {
  california: 'ca',
  'new york': 'ny',
  florida: 'fl',
  texas: 'tx',
  illinois: 'il',
  nevada: 'nv',
  georgia: 'ga',
  tennessee: 'tn',
  colorado: 'co',
  arizona: 'az',
  massachusetts: 'ma',
  pennsylvania: 'pa',
  washington: 'wa',
  oregon: 'or',
  'district of columbia': 'dc',
  louisiana: 'la',
  minnesota: 'mn',
  'north carolina': 'nc',
  michigan: 'mi',
  ohio: 'oh',
  indiana: 'in',
  missouri: 'mo',
  wisconsin: 'wi',
  maryland: 'md',
  utah: 'ut',
};

const HIGH_DENSITY_METROS = new Set([
  'los angeles',
  'west hollywood',
  'hollywood',
  'new york',
  'manhattan',
  'miami beach',
  'miami',
  'chicago',
  'austin',
  'dallas',
  'nashville',
  'las vegas',
  'atlanta',
  'houston',
  'seattle',
  'phoenix',
  'denver',
  'boston',
  'philadelphia',
  'san francisco',
  'san diego',
  'portland',
  'washington',
  'washington dc',
  'new orleans',
]);

@Injectable()
export class NormalizeHelper {
  normalizeToken(value: string | null | undefined): string {
    if (!value) return '';
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeStateToken(value: string | null | undefined): string {
    if (!value) return '';
    const trimmed = value.trim().toLowerCase();
    return STATE_MAP[trimmed] || trimmed;
  }

  venueReviewKey(
    venueName: string,
    city?: string | null,
    state?: string | null,
    postalCode?: string | null,
  ): string {
    const venueKey = this.normalizeToken(venueName);
    const cityKey = this.normalizeToken(city);
    const stateKey = this.normalizeStateToken(state);
    const postalKey = this.normalizePostalCode(postalCode);

    if (venueKey && postalKey) {
      return `venue:${venueKey}|postal:${postalKey}`;
    }
    if (venueKey && cityKey && stateKey) {
      return `venue:${venueKey}|city:${cityKey}|state:${stateKey}`;
    }
    return `venue:${venueKey}`;
  }

  sanitizeReviewRating(value: unknown): number | null {
    if (value === true || value === false) return null;
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      if (value === 'true' || value === 'false') return null;
      const trimmed = value.trim();
      if (trimmed === '' || trimmed === '0') return null;
      const parsed = parseFloat(trimmed);
      if (isNaN(parsed) || !isFinite(parsed)) return null;
      return parsed >= 1.0 && parsed <= 5.0 ? parsed : null;
    }
    if (typeof value === 'number') {
      if (!isFinite(value)) return null;
      return value >= 1.0 && value <= 5.0 ? value : null;
    }
    return null;
  }

  sanitizeReviewCount(value: unknown): number | null {
    if (typeof value === 'boolean') return null;
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      return isNaN(parsed) || parsed <= 0 ? null : parsed;
    }
    if (typeof value === 'number') {
      return value > 0 ? Math.floor(value) : null;
    }
    return null;
  }

  coordinateBucket(
    latitude: number,
    longitude: number,
    isHighDensity: boolean,
  ): { latitude: number; longitude: number } {
    const step = isHighDensity ? 0.12 : 0.08;
    return {
      latitude: Math.round(latitude / step) * step,
      longitude: Math.round(longitude / step) * step,
    };
  }

  cacheKey(
    intent: string,
    countryCode: string,
    latitude: number,
    longitude: number,
    isHighDensity: boolean,
  ): string {
    const bucket = this.coordinateBucket(latitude, longitude, isHighDensity);
    return [
      intent,
      countryCode,
      bucket.latitude.toFixed(2),
      bucket.longitude.toFixed(2),
    ].join('::');
  }

  isHighDensityMetro(city: string): boolean {
    return HIGH_DENSITY_METROS.has(this.normalizeToken(city));
  }

  dedupeBucketKey(event: {
    title: string;
    venueName?: string | null;
    startAtUTC?: string | null;
    city?: string | null;
    state?: string | null;
  }): string {
    const dayKey = event.startAtUTC
      ? new Date(event.startAtUTC).toISOString().substring(0, 10)
      : 'nodate';
    const venueKey = this.normalizeToken(event.venueName || '');
    const titleKey = this.normalizeToken(event.title).substring(0, 40);
    const stateKey = this.normalizeStateToken(event.state);
    return `${dayKey}::${venueKey || titleKey}::${stateKey}`;
  }

  isLikelyDuplicate(
    a: {
      title: string;
      venueName?: string | null;
      startAtUTC?: string | null;
    },
    b: {
      title: string;
      venueName?: string | null;
      startAtUTC?: string | null;
    },
  ): boolean {
    const aTitle = this.normalizeToken(a.title);
    const bTitle = this.normalizeToken(b.title);

    if (aTitle === bTitle) return true;

    const aVenue = this.normalizeToken(a.venueName);
    const bVenue = this.normalizeToken(b.venueName);

    if (aVenue && bVenue && aVenue === bVenue) {
      const similarity = this.jaccardSimilarity(
        aTitle.split(' '),
        bTitle.split(' '),
      );
      if (similarity > 0.5) return true;
    }

    return false;
  }

  private jaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a.filter((w) => w.length > 2));
    const setB = new Set(b.filter((w) => w.length > 2));
    if (setA.size === 0 && setB.size === 0) return 1;

    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private normalizePostalCode(value: string | null | undefined): string {
    if (!value) return '';
    const digits = value.replace(/\D/g, '');
    return digits.length >= 5 ? digits.substring(0, 5) : digits;
  }
}
