import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { TicketmasterHelper } from '../../helpers/ticketmaster.helper';
import { EventbriteHelper } from '../../helpers/eventbrite.helper';
import { GoogleEventsHelper } from '../../helpers/google-events.helper';
import { RunSignupHelper } from '../../helpers/runsignup.helper';
import { NightlifeEnrichmentHelper } from '../../helpers/nightlife-enrichment.helper';
import { GoogleReviewsHelper } from '../../helpers/google-reviews.helper';
import { SnapshotBuilderHelper } from '../../helpers/snapshot-builder.helper';
import { TileMathHelper } from '../../helpers/tile-math.helper';
import { NormalizeHelper } from '../../helpers/normalize.helper';
import {
  AdapterResult,
  EventResult,
  MetroRecord,
  TileCoordinate,
  WorkerConfig,
} from '../../utils';

@Injectable()
export class WorkerService {
  private running = false;
  private workerStartedAt: Date | null = null;
  private lastJobCompletedAt: Date | null = null;
  private totalJobsCompleted = 0;
  private totalJobsFailed = 0;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private readonly config: WorkerConfig;

  constructor(
    @InjectPinoLogger(WorkerService.name)
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly supabase: SupabaseClient,
    private readonly ticketmaster: TicketmasterHelper,
    private readonly eventbrite: EventbriteHelper,
    private readonly googleEvents: GoogleEventsHelper,
    private readonly runSignup: RunSignupHelper,
    private readonly nightlife: NightlifeEnrichmentHelper,
    private readonly googleReviews: GoogleReviewsHelper,
    private readonly snapshotBuilder: SnapshotBuilderHelper,
    private readonly tileMath: TileMathHelper,
    private readonly normalize: NormalizeHelper,
  ) {
    this.config = {
      workerId: this.configService.get<string>('worker.id')!,
      pollIntervalMs: this.configService.get<number>('worker.pollIntervalMs')!,
      heartbeatIntervalMs: this.configService.get<number>(
        'worker.heartbeatIntervalMs',
      )!,
      maxConcurrentJobs: this.configService.get<number>(
        'worker.maxConcurrentJobs',
      )!,
      heartbeatTimeoutMinutes: this.configService.get<number>(
        'worker.heartbeatTimeoutMinutes',
      )!,
      ticketmasterApiKey: this.configService.get<string>(
        'apiKeys.ticketmaster',
      ),
      eventbriteToken: this.configService.get<string>('apiKeys.eventbrite'),
    };
  }

  async startWorker() {
    if (this.running) {
      return { status: 'already_running', workerId: this.config.workerId };
    }

    this.running = true;
    this.workerStartedAt = new Date();
    this.logger.info({
      msg: 'worker_starting',
      workerId: this.config.workerId,
      pollIntervalMs: this.config.pollIntervalMs,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
    });

    let schedulerTickCount = 0;

    this.schedulerInterval = setInterval(async () => {
      schedulerTickCount++;

      const reclaimed = await this.reclaimStaleJobs();
      if (reclaimed > 0) {
        this.logger.info({
          msg: 'scheduler_reclaimed_stale_jobs',
          count: reclaimed,
        });
      }

      if (schedulerTickCount % 6 === 0) {
        const enqueued = await this.enqueueScheduledRefreshes();
        if (enqueued > 0) {
          this.logger.info({
            msg: 'scheduler_enqueued_refreshes',
            count: enqueued,
          });
        }
      }
    }, 60_000);

    const enqueued = await this.enqueueScheduledRefreshes();
    this.logger.info({
      msg: 'scheduler_initial_enqueue',
      count: enqueued,
    });

    // Start the poll loop in background (non-blocking)
    this.pollLoop();

    return { status: 'started', workerId: this.config.workerId };
  }

  stopWorker() {
    if (!this.running) {
      return { status: 'already_stopped' };
    }
    this.running = false;
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    this.logger.info({
      msg: 'worker_stop_requested',
      workerId: this.config.workerId,
    });
    return { status: 'stopping', workerId: this.config.workerId };
  }

  getWorkerStatus() {
    const uptimeMs = this.workerStartedAt
      ? Date.now() - this.workerStartedAt.getTime()
      : 0;
    return {
      status: this.running ? 'running' : 'stopped',
      workerId: this.config.workerId,
      uptime_ms: uptimeMs,
      uptime_human: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      started_at: this.workerStartedAt?.toISOString() ?? null,
      last_job_completed_at: this.lastJobCompletedAt?.toISOString() ?? null,
      total_jobs_completed: this.totalJobsCompleted,
      total_jobs_failed: this.totalJobsFailed,
    };
  }

  // ─── Poll Loop ──────────────────────────────────────────────────────

  private async pollLoop() {
    const activeJobs: Set<Promise<void>> = new Set();

    while (this.running) {
      try {
        if (activeJobs.size < this.config.maxConcurrentJobs) {
          const job = await this.claimJob();

          if (job) {
            this.logger.info({
              msg: 'job_claimed',
              jobId: job.id,
              metroId: job.metro_id,
              intent: job.intent,
              activeSlots: activeJobs.size + 1,
              maxSlots: this.config.maxConcurrentJobs,
            });

            const metro = await this.getMetro(job.metro_id);
            if (!metro) {
              this.logger.error({
                msg: 'metro_not_found',
                metroId: job.metro_id,
              });
              await this.failJob(job.id, 'Metro not found');
              continue;
            }

            const jobPromise = (async () => {
              const heartbeatInterval = setInterval(async () => {
                await this.heartbeatJob(job.id);
              }, this.config.heartbeatIntervalMs);

              try {
                await this.processJob(job, metro);
                await this.completeJob(job.id);
                this.lastJobCompletedAt = new Date();
                this.totalJobsCompleted++;
                this.logger.info({
                  msg: 'job_completed',
                  jobId: job.id,
                  metro: metro.display_name,
                  intent: job.intent,
                  activeSlots: activeJobs.size - 1,
                  maxSlots: this.config.maxConcurrentJobs,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error({
                  msg: 'job_failed',
                  jobId: job.id,
                  error: msg,
                });
                this.totalJobsFailed++;
                await this.failJob(job.id, msg);
              } finally {
                clearInterval(heartbeatInterval);
              }
            })();

            activeJobs.add(jobPromise);
            jobPromise.finally(() => activeJobs.delete(jobPromise));
            continue;
          }
        }

        if (activeJobs.size === 0) {
          await this.sleep(this.config.pollIntervalMs);
        } else if (activeJobs.size >= this.config.maxConcurrentJobs) {
          await Promise.race([...activeJobs, this.sleep(2000)]);
        } else {
          await this.sleep(2000);
        }
      } catch (err) {
        this.logger.error({
          msg: 'poll_loop_error',
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(5000);
      }
    }

    if (activeJobs.size > 0) {
      this.logger.info({
        msg: 'worker_draining',
        activeJobs: activeJobs.size,
      });
      await Promise.allSettled([...activeJobs]);
    }

    this.logger.info({ msg: 'worker_stopped' });
  }

  // ─── Process Job ────────────────────────────────────────────────────

  private async processJob(
    job: { id: string; metro_id: string; intent: string },
    metro: MetroRecord,
  ): Promise<void> {
    const startTime = Date.now();

    const runId = await this.insertRefreshRun({
      job_id: job.id,
      metro_id: job.metro_id,
      worker_id: this.config.workerId,
      intent: job.intent,
    });

    const adapterResults: AdapterResult[] = [];
    const notes: string[] = [];

    const settledAdapterResults = await Promise.allSettled([
      this.ticketmaster.fetchTicketmaster(metro, job.intent),
      this.eventbrite.fetchEventbrite(metro, job.intent),
      this.googleEvents.fetchGoogleEvents(metro, job.intent),
      this.runSignup.fetchRunSignup(metro, job.intent),
    ]);

    const adapterLabels = [
      'Ticketmaster',
      'Eventbrite',
      'Google Events',
      'RunSignup',
    ];
    for (let index = 0; index < settledAdapterResults.length; index++) {
      const settled = settledAdapterResults[index];
      if (settled.status === 'fulfilled') {
        adapterResults.push(settled.value);
        notes.push(...settled.value.notes);
      } else {
        notes.push(
          `${adapterLabels[index]} adapter error: ${String(settled.reason)}`,
        );
      }
    }

    let allEvents: EventResult[] = [];
    const eventsBySource = new Map<string, EventResult[]>();

    for (const result of adapterResults) {
      allEvents.push(...result.events);
      const existing = eventsBySource.get(result.source) || [];
      existing.push(...result.events);
      eventsBySource.set(result.source, existing);

      await this.recordSourceHealth({
        source: result.source,
        metro_id: job.metro_id,
        request_count: result.requestCount,
        success_count: result.successCount,
        failure_count: result.failureCount,
        timeout_count: result.timeoutCount,
        event_count: result.events.length,
        avg_latency_ms: result.avgLatencyMs,
      });
    }

    this.logger.info({
      msg: 'adapters_fetched',
      metro: metro.display_name,
      rawEventCount: allEvents.length,
      sourceCount: adapterResults.length,
    });

    // Nightlife enrichment
    const nightlifeResult = await this.nightlife.enrichEventsWithNightlife(
      allEvents,
      metro,
    );
    allEvents = nightlifeResult.events;
    notes.push(...nightlifeResult.notes);
    if (nightlifeResult.venueCount > 0) {
      this.logger.info({
        msg: 'nightlife_enriched',
        metro: metro.display_name,
        venueCount: nightlifeResult.venueCount,
      });
    }

    // Review enrichment
    const reviewResult = await this.googleReviews.enrichEventsWithReviews(
      allEvents,
      this.supabase,
    );
    allEvents = reviewResult.events;

    // Re-map enriched events back into eventsBySource
    for (const [source] of eventsBySource) {
      const enrichedForSource = allEvents.filter((e) => e.source === source);
      eventsBySource.set(source, enrichedForSource);
    }

    // Add nightlife events to eventsBySource
    const nightlifeEvents = allEvents.filter(
      (e) =>
        e.source === 'discotech' ||
        e.source === 'clubbable' ||
        e.source === 'hwood',
    );
    if (nightlifeEvents.length > 0) {
      for (const event of nightlifeEvents) {
        const existing = eventsBySource.get(event.source) || [];
        existing.push(event);
        eventsBySource.set(event.source, existing);
      }
    }

    // Build snapshot
    const snapshot = this.snapshotBuilder.buildSnapshot(
      metro,
      job.intent,
      eventsBySource,
      notes,
    );

    const isHighDensity = this.normalize.isHighDensityMetro(metro.city ?? '');
    const key = this.normalize.cacheKey(
      job.intent,
      metro.country_code ?? 'US',
      metro.latitude,
      metro.longitude,
      isHighDensity,
    );

    const ttlHours = this.ttlForIntent(job.intent);
    const fetchedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + ttlHours * 60 * 60 * 1000,
    ).toISOString();

    const nightlifeCount = snapshot.mergedEvents.filter(
      (e) => e.eventType === 'party / nightlife',
    ).length;
    const exclusiveCount = snapshot.mergedEvents.filter((e) => {
      const payload = JSON.parse(e.rawSourcePayload || '{}');
      return (
        e.eventType === 'party / nightlife' &&
        (payload.discotech_url || payload.clubbable_url)
      );
    }).length;

    const reviewEligible = snapshot.mergedEvents.filter(
      (e) => e.eventType !== 'party / nightlife',
    );
    const reviewCovered = reviewEligible.filter(
      (e) => this.normalize.sanitizeReviewRating(e.venueRating) !== null,
    );
    const reviewCoveragePct =
      reviewEligible.length > 0
        ? reviewCovered.length / reviewEligible.length
        : 0;

    const bucketSize = isHighDensity ? 0.12 : 0.08;
    const bucket = {
      latitude: Math.round(metro.latitude / bucketSize) * bucketSize,
      longitude: Math.round(metro.longitude / bucketSize) * bucketSize,
    };

    // Upsert snapshot
    const snapshotStored = await this.upsertSnapshot({
      cache_key: key,
      intent: job.intent,
      quality: 'full',
      country_code: metro.country_code ?? 'US',
      display_name: metro.display_name,
      city: metro.city ?? '',
      state: metro.state ?? '',
      postal_code: metro.postal_code ?? undefined,
      latitude: metro.latitude,
      longitude: metro.longitude,
      bucket_latitude: bucket.latitude,
      bucket_longitude: bucket.longitude,
      event_count: snapshot.mergedEvents.length,
      exclusive_count: exclusiveCount,
      nightlife_count: nightlifeCount,
      snapshot,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
      worker_id: this.config.workerId,
      run_id: runId ?? undefined,
      review_coverage_pct: reviewCoveragePct,
      is_server_generated: true,
    });
    if (!snapshotStored) {
      throw new Error(
        `Failed to persist snapshot for ${metro.display_name}/${job.intent}`,
      );
    }

    // Viewport tile materialization
    await this.materializeViewportTiles(
      metro,
      job,
      snapshot,
      key,
      fetchedAt,
      expiresAt,
      isHighDensity,
    );

    // Coverage metrics
    const uniqueVenues = new Set(
      snapshot.mergedEvents.map((e) => e.venueName).filter(Boolean),
    ).size;

    const sportsCount = snapshot.mergedEvents.filter(
      (e) => e.eventType === 'sports event',
    ).length;
    const concertCount = snapshot.mergedEvents.filter(
      (e) => e.eventType === 'concert',
    ).length;
    const communityCount = snapshot.mergedEvents.filter(
      (e) =>
        e.eventType === 'social / community event' ||
        e.eventType === 'weekend activity',
    ).length;

    await this.recordCoverageMetrics({
      metro_id: job.metro_id,
      intent: job.intent,
      total_events: snapshot.mergedEvents.length,
      unique_venues: uniqueVenues,
      review_eligible_count: reviewEligible.length,
      review_covered_count: reviewCovered.length,
      review_coverage_pct: reviewCoveragePct,
      nightlife_count: nightlifeCount,
      sports_count: sportsCount,
      concert_count: concertCount,
      community_count: communityCount,
      poisoned_review_count: reviewResult.poisonedCount ?? 0,
      stale_reason:
        snapshot.mergedEvents.length === 0 ? 'No events returned' : undefined,
      degraded_reason:
        reviewCoveragePct < 0.3 && reviewEligible.length >= 8
          ? `Low review coverage: ${(reviewCoveragePct * 100).toFixed(1)}%`
          : undefined,
      notes,
    });

    // Update refresh run
    const durationMs = Date.now() - startTime;

    if (runId) {
      await this.updateRefreshRun(runId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        event_count: snapshot.mergedEvents.length,
        venue_count: uniqueVenues,
        review_hit_count: reviewResult.hitCount,
        review_miss_count: reviewResult.missCount,
        review_error_count: reviewResult.errorCount,
        review_poisoned_count: reviewResult.poisonedCount ?? 0,
        nightlife_venue_count: nightlifeResult.venueCount,
        source_results: adapterResults.map((r) => ({
          source: r.source,
          event_count: r.events.length,
          request_count: r.requestCount,
          success_count: r.successCount,
          failure_count: r.failureCount,
        })),
        notes,
      });
    }

    this.logger.info({
      msg: 'job_processed',
      metro: metro.display_name,
      intent: job.intent,
      eventCount: snapshot.mergedEvents.length,
      uniqueVenues,
      reviewCoveragePct: +(reviewCoveragePct * 100).toFixed(1),
      poisonedReviews: reviewResult.poisonedCount ?? 0,
      nightlifeVenues: nightlifeResult.venueCount,
      durationMs,
    });
  }

  // ─── Viewport Tile Materialization ──────────────────────────────────

  private async materializeViewportTiles(
    metro: MetroRecord,
    job: { id: string; metro_id: string; intent: string },
    snapshot: { mergedEvents: any[] },
    snapshotKey: string,
    fetchedAt: string,
    expiresAt: string,
    isHighDensity: boolean,
  ): Promise<void> {
    const tileZoom = 11;
    const tilePadding = isHighDensity ? 4 : 3;
    const eventsWithCoords = snapshot.mergedEvents.filter(
      (e: any) =>
        typeof e.latitude === 'number' && typeof e.longitude === 'number',
    );
    const tiles = this.buildViewportTileCoverage(
      metro.latitude,
      metro.longitude,
      eventsWithCoords,
      tileZoom,
      tilePadding,
      isHighDensity ? 1 : 0,
      isHighDensity ? 225 : 144,
    );

    let tileSuccessCount = 0;
    let tileFailureCount = 0;

    await this.runWithConcurrency(8, tiles, async (tile) => {
      const bounds = this.tileMath.tileBounds(tile);
      const tileEvents = eventsWithCoords.filter(
        (e: any) =>
          e.latitude >= bounds.southLatitude &&
          e.latitude <= bounds.northLatitude &&
          e.longitude >= bounds.westLongitude &&
          e.longitude <= bounds.eastLongitude,
      );

      const tileKey = this.tileMath.tileKeyString(
        job.intent,
        metro.country_code ?? 'US',
        metro.state ?? null,
        tile.z,
        tile.x,
        tile.y,
      );

      const tileNightlife = tileEvents.filter(
        (e: any) => e.eventType === 'party / nightlife',
      ).length;
      const tileExclusive = tileEvents.filter((e: any) => {
        const payload = JSON.parse(e.rawSourcePayload || '{}');
        return (
          e.eventType === 'party / nightlife' &&
          (payload.discotech_url || payload.clubbable_url)
        );
      }).length;

      const tileSnapshot = {
        tile: {
          intent: job.intent,
          countryCode: metro.country_code ?? 'US',
          state: metro.state ?? '',
          z: tile.z,
          x: tile.x,
          y: tile.y,
        },
        bounds,
        searchLocations: [
          {
            city: metro.city ?? '',
            state: metro.state ?? '',
            latitude: metro.latitude,
            longitude: metro.longitude,
            displayName: metro.display_name,
          },
        ],
        mergedEvents: tileEvents,
        notes: [],
        quality: tileEvents.length > 0 ? 'full' : 'empty',
        fetchedAt,
        expiresAt,
        eventCount: tileEvents.length,
        exclusiveCount: tileExclusive,
        nightlifeCount: tileNightlife,
      };

      const persisted = await this.upsertViewportTile({
        tile_key: tileKey,
        intent: job.intent,
        z: tile.z,
        x: tile.x,
        y: tile.y,
        quality: tileEvents.length > 0 ? 'full' : 'empty',
        country_code: metro.country_code ?? 'US',
        state: metro.state ?? '',
        bounds,
        source_snapshot_keys: [snapshotKey],
        event_count: tileEvents.length,
        exclusive_count: tileExclusive,
        nightlife_count: tileNightlife,
        snapshot: tileSnapshot,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
      });

      if (persisted) {
        tileSuccessCount++;
      } else {
        tileFailureCount++;
      }
    });

    this.logger.info({
      msg: 'viewport_tiles_materialized',
      metro: metro.display_name,
      intent: job.intent,
      successCount: tileSuccessCount,
      totalTiles: tiles.length,
      failedCount: tileFailureCount,
      padding: tilePadding,
    });

    if (tiles.length > 0 && tileSuccessCount === 0) {
      throw new Error(
        `Viewport tile writes failed for all ${tiles.length} tiles`,
      );
    }
    if (tileFailureCount > Math.max(3, Math.floor(tiles.length * 0.25))) {
      throw new Error(
        `Viewport tile writes failed for ${tileFailureCount}/${tiles.length} tiles`,
      );
    }
  }

  private buildViewportTileCoverage(
    metroLatitude: number,
    metroLongitude: number,
    events: Array<{ latitude?: number; longitude?: number }>,
    zoom: number,
    metroPadding: number,
    eventHalo: number,
    maxTiles: number,
  ): TileCoordinate[] {
    const baseTiles = this.tileMath.tilesForMetro(
      metroLatitude,
      metroLongitude,
      zoom,
      metroPadding,
    );
    const centerTile = this.tileMath.latLonToTile(
      metroLatitude,
      metroLongitude,
      zoom,
    );
    const maxIndex = Math.pow(2, zoom) - 1;
    const deduped = new Map<string, TileCoordinate>();

    for (const tile of baseTiles) {
      deduped.set(`${tile.z}:${tile.x}:${tile.y}`, tile);
    }

    for (const event of events) {
      if (
        typeof event.latitude !== 'number' ||
        typeof event.longitude !== 'number'
      ) {
        continue;
      }
      const eventTile = this.tileMath.latLonToTile(
        event.latitude,
        event.longitude,
        zoom,
      );
      for (let dx = -eventHalo; dx <= eventHalo; dx++) {
        for (let dy = -eventHalo; dy <= eventHalo; dy++) {
          const tile: TileCoordinate = {
            z: zoom,
            x: Math.min(Math.max(eventTile.x + dx, 0), maxIndex),
            y: Math.min(Math.max(eventTile.y + dy, 0), maxIndex),
          };
          deduped.set(`${tile.z}:${tile.x}:${tile.y}`, tile);
        }
      }
    }

    return [...deduped.values()]
      .sort(
        (a, b) =>
          this.tileGridDistance(a, centerTile) -
          this.tileGridDistance(b, centerTile),
      )
      .slice(0, maxTiles);
  }

  private tileGridDistance(a: TileCoordinate, b: TileCoordinate): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private ttlForIntent(intent: string): number {
    switch (intent) {
      case 'biggest_tonight':
        return 48;
      case 'last_minute_plans':
        return 24;
      case 'exclusive_hot':
        return 72;
      case 'nearby_and_worth_it':
        return 96;
      default:
        return 48;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async runWithConcurrency<T>(
    limit: number,
    items: T[],
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = [...items];
    const active = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) return;
          await worker(item);
        }
      },
    );
    await Promise.all(active);
  }

  // ─── Supabase Operations ────────────────────────────────────────────

  private async claimJob(): Promise<{
    id: string;
    metro_id: string;
    intent: string;
  } | null> {
    const { data, error } = await this.supabase.rpc('claim_refresh_job', {
      p_worker_id: this.config.workerId,
    });
    if (error || !data || data.length === 0) return null;
    return data[0];
  }

  private async heartbeatJob(jobId: string): Promise<void> {
    await this.supabase.rpc('heartbeat_refresh_job', {
      p_job_id: jobId,
      p_worker_id: this.config.workerId,
    });
  }

  private async completeJob(jobId: string): Promise<void> {
    await this.supabase.rpc('complete_refresh_job', {
      p_job_id: jobId,
      p_worker_id: this.config.workerId,
    });
  }

  private async failJob(jobId: string, reason: string): Promise<void> {
    await this.supabase.rpc('fail_refresh_job', {
      p_job_id: jobId,
      p_worker_id: this.config.workerId,
      p_error_message: reason,
    });
  }

  private async reclaimStaleJobs(): Promise<number> {
    const { data, error } = await this.supabase.rpc('reclaim_stale_jobs', {
      p_heartbeat_timeout_minutes: this.config.heartbeatTimeoutMinutes,
    });
    if (error) return 0;
    return typeof data === 'number' ? data : 0;
  }

  private async enqueueScheduledRefreshes(): Promise<number> {
    const { data, error } = await this.supabase.rpc(
      'enqueue_scheduled_refreshes',
    );
    if (error) return 0;
    return typeof data === 'number' ? data : 0;
  }

  private async getMetro(metroId: string): Promise<MetroRecord | null> {
    const { data, error } = await this.supabase
      .from('ingestion_metros')
      .select('*')
      .eq('id', metroId)
      .single();
    if (error || !data) return null;
    return data as MetroRecord;
  }

  private async insertRefreshRun(params: {
    job_id: string;
    metro_id: string;
    worker_id: string;
    intent: string;
  }): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('refresh_runs')
      .insert({
        job_id: params.job_id,
        metro_id: params.metro_id,
        worker_id: params.worker_id,
        intent: params.intent,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !data) return null;
    return data.id;
  }

  private async updateRefreshRun(
    runId: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    await this.supabase.from('refresh_runs').update(updates).eq('id', runId);
  }

  private async upsertSnapshot(
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const { error } = await this.supabase
      .from('external_event_snapshots')
      .upsert(params, { onConflict: 'cache_key,intent' });
    return !error;
  }

  private async upsertViewportTile(
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const { error } = await this.supabase
      .from('external_event_viewport_tiles')
      .upsert(params, { onConflict: 'tile_key' });
    return !error;
  }

  private async recordSourceHealth(
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.supabase.from('source_health').insert({
      ...params,
      recorded_at: new Date().toISOString(),
    });
  }

  private async recordCoverageMetrics(
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.supabase.from('coverage_metrics').insert({
      ...params,
      recorded_at: new Date().toISOString(),
    });
  }
}
