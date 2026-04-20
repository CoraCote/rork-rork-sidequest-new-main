import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { httpClient } from '../utils';

export interface ClubbableOpeningHours {
  days: string[];
  opens: string;
  closes: string;
}

export interface ClubbableClub {
  name: string;
  slug: string;
  url: string;
  imageUrl: string;
  description: string | null;
  address: string;
  addressLocality: string | null;
  addressRegion: string | null;
  addressCountry: string | null;
  postalCode: string | null;
  lat: number;
  lng: number;
  day: string;
  isOpen: boolean;
  rating: number | null;
  reviewCount: number | null;
  priceRange: string | null;
  telephone: string | null;
  openingHours: ClubbableOpeningHours[];
  error?: string;
}

export interface ClubbableCity {
  name: string;
  slug: string;
  url: string;
  clubs: ClubbableClub[];
}

export interface ClubbableCityListItem {
  name: string;
  slug: string;
  url: string;
}

interface ClubbableClubListItem {
  name: string;
  slug: string;
  address: string;
  lat: number;
  lng: number;
  day: string;
  isOpen: boolean;
  imageUrl: string;
  detailUrl: string;
}

@Injectable()
export class ClubbableHelper {
  private readonly baseUrl = 'https://www.clubbable.com';
  private readonly imageBase = 'https://clubbable.blob.core.windows.net/medias';
  private readonly clubDetailConcurrency = 10;
  private readonly cityConcurrency = 5;

  async fetchCities(): Promise<ClubbableCityListItem[]> {
    const html = await this.fetchHtml(`${this.baseUrl}/`);
    const $ = cheerio.load(html);
    const seen = new Map<string, ClubbableCityListItem>();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const match = href.match(/^\/([A-Za-z][A-Za-z-]*)$/);
      if (!match) return;
      const slug = match[1];
      if (this.isReservedSlug(slug)) return;
      const title = ($(el).attr('title') || $(el).text() || '').trim();
      if (!title) return;
      if (seen.has(slug)) return;
      seen.set(slug, {
        name: slug.replace('-', ''),
        slug,
        url: `${this.baseUrl}/${slug}`,
      });
    });

    return Array.from(seen.values());
  }

  async fetchCityClubs(citySlug: string): Promise<ClubbableClubListItem[]> {
    const html = await this.fetchHtml(`${this.baseUrl}/${citySlug}`);
    const clubs: ClubbableClubListItem[] = [];
    const seenSlugs = new Set<string>();

    const pushRegex =
      /(openClubAddresses|notOpenClubAddresses)\.push\(\s*\{([\s\S]*?)\}\s*\)/g;
    let match: RegExpExecArray | null;

    while ((match = pushRegex.exec(html)) !== null) {
      const bucket = match[1];
      const body = match[2];

      const name = this.extractString(body, 'name');
      const address = this.extractString(body, 'address');
      const day = this.extractString(body, 'day');
      const lat = this.extractNumber(body, 'lat');
      const lng = this.extractNumber(body, 'lng');

      if (!name || lat === null || lng === null) continue;

      const slug = this.toClubSlug(name);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      clubs.push({
        name,
        slug,
        address: address ?? '',
        lat,
        lng,
        day: day ?? '',
        isOpen: bucket === 'openClubAddresses',
        imageUrl: `${this.imageBase}/${slug}-`,
        detailUrl: `${this.baseUrl}/${citySlug}/${slug}`,
      });
    }

    return clubs;
  }

  async fetchClubDetail(
    listItem: ClubbableClubListItem,
  ): Promise<ClubbableClub> {
    const url = listItem.detailUrl;
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    let localBusiness: Record<string, unknown> | null = null;
    let nightClub: Record<string, unknown> | null = null;
    let description: string | null = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      if (!description) {
        const descMatch = raw.match(
          /"description"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/,
        );
        if (descMatch) {
          const cleaned = descMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\s+\n/g, '\n')
            .trim();
          if (cleaned.length > 0) description = cleaned;
        }
      }
      try {
        const sanitized = raw.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (m) =>
          m.replace(/\n/g, '\\n').replace(/\r/g, '\\r'),
        );
        const parsed = JSON.parse(sanitized);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== 'object') continue;
          const type = (candidate as Record<string, unknown>)['@type'];
          if (type === 'LocalBusiness') {
            localBusiness = candidate as Record<string, unknown>;
          } else if (type === 'NightClub') {
            nightClub = candidate as Record<string, unknown>;
          }
        }
      } catch {
        /* skip malformed JSON-LD */
      }
    });

    const nameFromScript =
      html.match(/var\s+clubName\s*=\s*"([^"]*)"/)?.[1] ?? listItem.name;
    const ogImage = $('meta[property="og:image"]').attr('content') ?? '';

    const address = this.readObject(localBusiness, 'address');
    const rating = this.readObject(localBusiness, 'aggregateRating');

    const openingHours: ClubbableOpeningHours[] = [];
    const nightClubHours = this.readValue(
      nightClub,
      'openingHoursSpecification',
    );
    if (Array.isArray(nightClubHours)) {
      for (const entry of nightClubHours) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const dayOfWeek = record.dayOfWeek;
        const opens = record.opens;
        const closes = record.closes;
        if (typeof opens !== 'string' || typeof closes !== 'string') continue;
        openingHours.push({
          days: Array.isArray(dayOfWeek)
            ? dayOfWeek.filter((d): d is string => typeof d === 'string')
            : typeof dayOfWeek === 'string'
              ? [dayOfWeek]
              : [],
          opens,
          closes,
        });
      }
    }

    return {
      name: nameFromScript,
      slug: listItem.slug,
      url,
      imageUrl: ogImage || listItem.imageUrl,
      description,
      address: listItem.address,
      addressLocality: this.asString(
        this.readValue(address, 'addressLocality'),
      ),
      addressRegion: this.asString(this.readValue(address, 'addressRegion')),
      addressCountry: this.unwrapNamedValue(
        this.readValue(address, 'addressCountry'),
      ),
      postalCode: this.asString(this.readValue(address, 'postalCode')),
      lat: listItem.lat,
      lng: listItem.lng,
      day: listItem.day,
      isOpen: listItem.isOpen,
      rating: this.asNumber(this.readValue(rating, 'ratingValue')),
      reviewCount: this.asNumber(this.readValue(rating, 'reviewCount')),
      priceRange: this.asString(this.readValue(localBusiness, 'priceRange')),
      telephone: this.asString(this.readValue(localBusiness, 'telephone')),
      openingHours,
    };
  }

  async fetchCityWithClubs(citySlug: string): Promise<ClubbableCity> {
    const cities = await this.fetchCities();
    const city = cities.find(
      (c) => c.slug.toLowerCase() === citySlug.toLowerCase(),
    ) ?? {
      name: citySlug,
      slug: citySlug,
      url: `${this.baseUrl}/${citySlug}`,
    };

    const listItems = await this.fetchCityClubs(city.slug);
    const clubs = await this.runWithConcurrency(
      listItems,
      this.clubDetailConcurrency,
      async (item) => {
        try {
          return await this.fetchClubDetail(item);
        } catch (error) {
          return this.buildErrorClub(
            item,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    return { ...city, clubs };
  }

  async fetchAllCitiesWithClubs(): Promise<ClubbableCity[]> {
    const cities = await this.fetchCities();
    return (
      await this.runWithConcurrency(
        cities,
        this.cityConcurrency,
        async (city) => {
          const listItems = await this.fetchCityClubs(city.slug).catch(
            () => [],
          );
          const clubs = await this.runWithConcurrency(
            listItems,
            this.clubDetailConcurrency,
            async (item) => {
              try {
                return await this.fetchClubDetail(item);
              } catch (error) {
                return this.buildErrorClub(
                  item,
                  error instanceof Error ? error.message : String(error),
                );
              }
            },
          );
          return { ...city, clubs };
        },
      )
    ).filter((item) => item.clubs.length);
  }

  private buildErrorClub(
    item: ClubbableClubListItem,
    error: string,
  ): ClubbableClub {
    return {
      name: item.name,
      slug: item.slug,
      url: item.detailUrl,
      imageUrl: item.imageUrl,
      description: null,
      address: item.address,
      addressLocality: null,
      addressRegion: null,
      addressCountry: null,
      postalCode: null,
      lat: item.lat,
      lng: item.lng,
      day: item.day,
      isOpen: item.isOpen,
      rating: null,
      reviewCount: null,
      priceRange: null,
      telephone: null,
      openingHours: [],
      error,
    };
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await httpClient.get<string>(url, {
      responseType: 'text',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Clubbable HTTP ${response.status} for ${url}`);
    }
    return response.data;
  }

  private extractString(body: string, key: string): string | null {
    const re = new RegExp(
      `${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
    );
    const match = body.match(re);
    const raw = match?.[1] ?? match?.[2];
    return raw !== undefined
      ? raw.replace(/\\"/g, '"').replace(/\\'/g, "'")
      : null;
  }

  private extractNumber(body: string, key: string): number | null {
    const match = body.match(new RegExp(`${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (!match) return null;
    const parsed = parseFloat(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toClubSlug(name: string): string {
    return name
      .trim()
      .replace(/&/g, 'and')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  private isReservedSlug(slug: string): boolean {
    const reserved = new Set([
      'About',
      'About-us',
      'Contact',
      'Contact-us',
      'Login',
      'Register',
      'Signup',
      'Sign-up',
      'Signin',
      'Sign-in',
      'Terms',
      'Terms-and-conditions',
      'Terms-of-service',
      'Privacy',
      'Privacy-policy',
      'Cookie-policy',
      'Cookies',
      'Faq',
      'Faqs',
      'Home',
      'Blog',
      'Search',
      'Account',
      'Cities',
      'Clubs',
      'Help',
      'Support',
      'Press',
      'Careers',
      'Jobs',
      'Partners',
      'Advertise',
      'Legal',
      'Disclaimer',
      'Sitemap',
    ]);
    if (reserved.has(slug)) return true;
    const lower = slug.toLowerCase();
    const stopwords = [
      'about',
      'contact',
      'terms',
      'privacy',
      'cookie',
      'policy',
      'login',
      'signup',
      'signin',
      'register',
      'faq',
      'help',
      'support',
      'press',
      'career',
      'job',
      'partner',
      'advertise',
      'legal',
      'disclaimer',
      'sitemap',
      'blog',
    ];
    return stopwords.some((w) => lower.includes(w));
  }

  private readObject(
    source: Record<string, unknown> | null,
    key: string,
  ): Record<string, unknown> | null {
    if (!source) return null;
    const value = source[key];
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
  }

  private readValue(
    source: Record<string, unknown> | null,
    key: string,
  ): unknown {
    if (!source) return undefined;
    return source[key];
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private unwrapNamedValue(value: unknown): string | null {
    if (typeof value === 'string') return value.length > 0 ? value : null;
    if (value && typeof value === 'object') {
      const name = (value as Record<string, unknown>).name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    return null;
  }

  private async runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const runners = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          results[index] = await worker(items[index]);
        }
      },
    );
    await Promise.all(runners);
    return results;
  }
}
