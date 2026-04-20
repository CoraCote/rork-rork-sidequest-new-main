import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { GeoHelper } from '../../helpers/geo.helper';
import { TileMathHelper } from '../../helpers/tile-math.helper';
import { MetroRecord, EnqueueResult, JobQueueEntry } from '../../utils';
import { DEFAULT_INTENTS } from '../../utils/enums';

@Injectable()
export class TriggerService {
  constructor(
    @InjectPinoLogger(TriggerService.name)
    private readonly logger: PinoLogger,
    private readonly supabase: SupabaseClient,
    private readonly geo: GeoHelper,
    private readonly tileMath: TileMathHelper,
  ) {}

  // ─── Trigger Refresh ───────────────────────────────────────────────

  async triggerRefresh(metroSlug: string, intent?: string) {
    const metro = await this.loadMetroOrFail(metroSlug);

    const enqueueResult = await this.enqueueJobs([
      {
        metro_id: metro.id,
        intent: intent || 'nearby_and_worth_it',
        priority: 1,
      },
    ]);

    return {
      status: enqueueResult.inserted > 0 ? 'enqueued' : 'already_pending',
      metro,
      inserted: enqueueResult.inserted,
      skipped: enqueueResult.skipped,
      jobs: enqueueResult.jobs,
    };
  }

  // ─── Trigger Backfill ──────────────────────────────────────────────

  async triggerBackfill(tier: number) {
    const { data: metros, error } = await this.supabase
      .from('ingestion_metros')
      .select('id, slug')
      .eq('enabled', true)
      .lte('tier', tier)
      .order('tier', { ascending: true });

    if (error || !Array.isArray(metros)) {
      throw new BadRequestException('Failed to fetch metros');
    }

    const typedMetros = metros as { id: string; slug: string }[];
    const jobs: JobQueueEntry[] = typedMetros.flatMap((metro) =>
      DEFAULT_INTENTS.map((intent) => ({
        metro_id: metro.id,
        intent,
        priority: 2,
      })),
    );

    const enqueueResult = await this.enqueueJobs(jobs);

    return {
      status: 'backfill_enqueued',
      metro_count: metros.length,
      job_count: enqueueResult.inserted,
      skipped_jobs: enqueueResult.skipped,
    };
  }

  // ─── Trigger Metro Refresh ─────────────────────────────────────────

  async triggerMetroRefresh(metroSlug: string) {
    const metro = await this.loadMetroOrFail(metroSlug);

    const jobs: JobQueueEntry[] = DEFAULT_INTENTS.map((intent) => ({
      metro_id: metro.id,
      intent,
      priority: 1,
    }));

    const enqueueResult = await this.enqueueJobs(jobs);

    return {
      status: enqueueResult.inserted > 0 ? 'enqueued' : 'already_pending',
      metro,
      job_count: enqueueResult.inserted,
      skipped_jobs: enqueueResult.skipped,
    };
  }

  // ─── Trigger Tile Scrape ───────────────────────────────────────────

  async triggerTileScrape(z: number, x: number, y: number) {
    const center = this.geo.tileCenter(z, x, y);
    const allMetros = await this.loadEnabledMetros();

    const coverageMetros = this.geo.selectCoverageMetros(
      allMetros,
      center.lat,
      center.lon,
      90,
      3,
    );

    if (coverageMetros.length === 0) {
      return {
        status: 'no_coverage',
        message: 'No metro within range of this tile',
        tile: { z, x, y },
        center,
      };
    }

    const jobs: JobQueueEntry[] = coverageMetros.flatMap((metro) =>
      DEFAULT_INTENTS.map((intent) => ({
        metro_id: metro.id,
        intent,
        priority: 0,
      })),
    );

    const enqueueResult = await this.enqueueJobs(jobs);

    return {
      status: 'scrape_triggered',
      metros: coverageMetros.map((m) => ({
        slug: m.slug,
        display_name: m.display_name,
      })),
      tile: { z, x, y },
      center,
      jobs_created: enqueueResult.inserted,
      skipped_jobs: enqueueResult.skipped,
    };
  }

  // ─── Trigger Metro Batch ───────────────────────────────────────────

  async triggerMetroBatch(metroSlug: string) {
    const metro = await this.loadMetroOrFail(metroSlug);

    const freshIntents = await this.fetchFreshSnapshotIntents(
      metro,
      DEFAULT_INTENTS,
    );

    const staleIntents = DEFAULT_INTENTS.filter(
      (intent) => !freshIntents.has(intent),
    );

    if (staleIntents.length === 0) {
      return {
        status: 'all_fresh',
        metro,
        intents_fresh: DEFAULT_INTENTS.length,
      };
    }

    const jobs: JobQueueEntry[] = staleIntents.map((intent) => ({
      metro_id: metro.id,
      intent,
      priority: 0,
    }));

    const enqueueResult = await this.enqueueJobs(jobs);

    return {
      status: enqueueResult.inserted > 0 ? 'batch_enqueued' : 'already_pending',
      metro,
      intents_enqueued: staleIntents,
      intents_fresh: DEFAULT_INTENTS.filter((i) => freshIntents.has(i)),
      job_count: enqueueResult.inserted,
      skipped_jobs: enqueueResult.skipped,
    };
  }

  // ─── Trigger On-Demand Tile ────────────────────────────────────────

  async triggerOnDemandTile(
    z?: number,
    x?: number,
    y?: number,
    lat?: number,
    lon?: number,
  ) {
    if ((z == null || x == null || y == null) && (lat == null || lon == null)) {
      throw new BadRequestException('Provide z/x/y or lat/lon');
    }

    let centerLat: number;
    let centerLon: number;

    if (lat != null && lon != null) {
      centerLat = lat;
      centerLon = lon;
    } else {
      const center = this.geo.tileCenter(z!, x!, y!);
      centerLat = center.lat;
      centerLon = center.lon;
    }

    const tileZoom = 11;
    const tile = this.geo.tileFromLatLon(centerLat, centerLon, tileZoom);

    const freshTileIntents = await this.fetchFreshTileIntents(tile);
    const missingIntents = DEFAULT_INTENTS.filter(
      (intent) => !freshTileIntents.has(intent),
    );

    if (missingIntents.length === 0) {
      return {
        status: 'tiles_exist',
        tile,
        intents_fresh: DEFAULT_INTENTS.length,
      };
    }

    const allMetros = await this.loadEnabledMetros();
    const coverageMetros = this.geo.selectCoverageMetros(
      allMetros,
      centerLat,
      centerLon,
      90,
      3,
    );

    if (coverageMetros.length === 0) {
      return {
        status: 'no_coverage',
        message: 'No metro within range',
        center: { lat: centerLat, lon: centerLon },
      };
    }

    const jobs: JobQueueEntry[] = coverageMetros.flatMap((metro) =>
      missingIntents.map((intent) => ({
        metro_id: metro.id,
        intent,
        priority: 0,
      })),
    );

    const enqueueResult = await this.enqueueJobs(jobs);

    return {
      status: 'on_demand_triggered',
      metros: coverageMetros.map((m) => ({
        slug: m.slug,
        display_name: m.display_name,
      })),
      tile,
      center: { lat: centerLat, lon: centerLon },
      missing_intents: missingIntents,
      jobs_created: enqueueResult.inserted,
      skipped_jobs: enqueueResult.skipped,
    };
  }

  // ─── Trigger POI Refresh ───────────────────────────────────────────

  async triggerPoiRefresh(metroSlug: string) {
    const metro = await this.loadMetroOrFail(metroSlug);

    const zoom = 12;
    const scale = Math.pow(2, zoom);
    const center = this.tileMath.latLonToTile(
      metro.latitude,
      metro.longitude,
      zoom,
    );
    const padding = 3;
    const maxTile = scale - 1;

    const tiles: { z: number; x: number; y: number }[] = [];
    for (let dx = -padding; dx <= padding; dx++) {
      for (let dy = -padding; dy <= padding; dy++) {
        tiles.push({
          z: zoom,
          x: Math.min(Math.max(center.x + dx, 0), maxTile),
          y: Math.min(Math.max(center.y + dy, 0), maxTile),
        });
      }
    }

    let tilesWritten = 0;

    for (const tile of tiles) {
      const snapshotPayload = {
        tile: {
          countryCode: metro.country_code,
          z: tile.z,
          x: tile.x,
          y: tile.y,
        },
        pois: [],
        poiCount: 0,
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };

      const { error } = await this.supabase.from('poi_viewport_tiles').upsert(
        {
          country_code: metro.country_code,
          z: tile.z,
          x: tile.x,
          y: tile.y,
          snapshot: snapshotPayload,
          poi_count: 0,
          fetched_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        { onConflict: 'country_code,z,x,y' },
      );

      if (!error) tilesWritten++;
    }

    return {
      status: 'poi_tiles_seeded',
      metro: metro.display_name,
      tiles_written: tilesWritten,
      total_tiles: tiles.length,
      zoom,
    };
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  private async loadMetroOrFail(slug: string): Promise<MetroRecord> {
    const { data, error } = await this.supabase
      .from('ingestion_metros')
      .select(
        'id, slug, display_name, city, state, country_code, latitude, longitude',
      )
      .eq('slug', slug)
      .eq('enabled', true)
      .limit(1)
      .single();

    if (error || !data) {
      throw new NotFoundException('Metro not found');
    }

    return data as MetroRecord;
  }

  private async loadEnabledMetros(): Promise<MetroRecord[]> {
    const { data, error } = await this.supabase
      .from('ingestion_metros')
      .select(
        'id, slug, display_name, city, state, country_code, latitude, longitude',
      )
      .eq('enabled', true);

    if (error || !data || data.length === 0) {
      throw new NotFoundException('No metros available');
    }

    return data as MetroRecord[];
  }

  private async enqueueJobs(jobs: JobQueueEntry[]): Promise<EnqueueResult> {
    if (jobs.length === 0) {
      return { inserted: 0, skipped: 0, jobs: [] };
    }

    const metroIds = [...new Set(jobs.map((j) => j.metro_id))];
    const intents = [...new Set(jobs.map((j) => j.intent))];

    const { data: activeJobs } = await this.supabase
      .from('refresh_jobs')
      .select('metro_id, intent, status')
      .in('status', ['pending', 'claimed'])
      .in('metro_id', metroIds)
      .in('intent', intents)
      .limit(1000);

    const activeKeys = new Set(
      Array.isArray(activeJobs)
        ? activeJobs.map((row) => `${row.metro_id}::${row.intent}`)
        : [],
    );

    const dedupedJobs = jobs.filter(
      (job) => !activeKeys.has(`${job.metro_id}::${job.intent}`),
    );

    if (dedupedJobs.length === 0) {
      return { inserted: 0, skipped: jobs.length, jobs: [] };
    }

    const { data: insertedJobs, error } = await this.supabase
      .from('refresh_jobs')
      .insert(dedupedJobs)
      .select();

    if (error) {
      this.logger.error({
        msg: 'enqueue_jobs_failed',
        error: error.message,
      });
      throw new Error(`Failed to enqueue jobs: ${error.message}`);
    }

    return {
      inserted: insertedJobs?.length ?? dedupedJobs.length,
      skipped: jobs.length - dedupedJobs.length,
      jobs: insertedJobs ?? [],
    };
  }

  private async fetchFreshSnapshotIntents(
    metro: MetroRecord,
    intents: readonly string[],
  ): Promise<Set<string>> {
    const { data } = await this.supabase
      .from('external_event_snapshots')
      .select('intent, expires_at, event_count')
      .eq('latitude', metro.latitude)
      .eq('longitude', metro.longitude)
      .in('intent', [...intents])
      .gte('expires_at', new Date().toISOString())
      .limit(20);

    const rows = (data ?? []) as { intent: string }[];
    return new Set(rows.map((row) => row.intent));
  }

  private async fetchFreshTileIntents(tile: {
    z: number;
    x: number;
    y: number;
  }): Promise<Set<string>> {
    const { data } = await this.supabase
      .from('external_event_viewport_tiles')
      .select('intent, event_count, expires_at')
      .eq('z', tile.z)
      .eq('x', tile.x)
      .eq('y', tile.y)
      .gte('expires_at', new Date().toISOString())
      .gt('event_count', 0)
      .limit(20);

    const rows = (data ?? []) as { intent: string }[];
    return new Set(rows.map((row) => row.intent));
  }
}
