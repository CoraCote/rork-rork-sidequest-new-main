import { Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  IngestionStatusResponse,
  SourceHealthEntry,
  SourceHealthResponse,
} from '../../utils';

@Injectable()
export class IngestionService {
  constructor(private readonly supabase: SupabaseClient) {}

  async getStatus(): Promise<IngestionStatusResponse> {
    const [jobsResult, runsResult, metrosResult] = await Promise.all([
      this.supabase
        .from('refresh_jobs')
        .select('status')
        .order('created_at', { ascending: false })
        .limit(200),
      this.supabase
        .from('refresh_runs')
        .select(
          'status, duration_ms, event_count, review_hit_count, review_miss_count',
        )
        .order('started_at', { ascending: false })
        .limit(50),
      this.supabase
        .from('ingestion_metros')
        .select('slug, tier, last_refresh_at, enabled')
        .eq('enabled', true)
        .order('tier', { ascending: true }),
    ]);

    const jobsByStatus: Record<string, number> = {};
    for (const job of jobsResult.data ?? []) {
      const status = String(job['status']);
      jobsByStatus[status] = (jobsByStatus[status] || 0) + 1;
    }

    const recentRuns = (runsResult.data ?? []).slice(0, 20);

    const avgDuration =
      recentRuns.length > 0
        ? Math.round(
            recentRuns.reduce(
              (sum, run) => sum + (Number(run['duration_ms']) || 0),
              0,
            ) / recentRuns.length,
          )
        : 0;

    const totalEvents = recentRuns.reduce(
      (sum, run) => sum + (Number(run['event_count']) || 0),
      0,
    );

    return {
      jobs: jobsByStatus,
      recent_runs: {
        count: recentRuns.length,
        avg_duration_ms: avgDuration,
        total_events: totalEvents,
      },
      metros: metrosResult.data?.length ?? 0,
    };
  }

  async getSourceHealth(): Promise<SourceHealthResponse> {
    const { data, error } = await this.supabase
      .from('source_health')
      .select(
        'source, request_count, success_count, failure_count, timeout_count, event_count, avg_latency_ms',
      )
      .order('window_start', { ascending: false })
      .limit(100);

    if (error) {
      throw new Error(`Failed to load source health: ${error.message}`);
    }

    const bySource: Record<string, SourceHealthEntry> = {};

    for (const row of data ?? []) {
      const sourceName = String(row['source']);

      if (!bySource[sourceName]) {
        bySource[sourceName] = {
          total_requests: 0,
          total_successes: 0,
          total_failures: 0,
          total_timeouts: 0,
          total_events: 0,
          avg_latency_ms: 0,
          success_rate: 'N/A',
          windows: 0,
        };
      }

      const source = bySource[sourceName];
      source.total_requests += Number(row['request_count']) || 0;
      source.total_successes += Number(row['success_count']) || 0;
      source.total_failures += Number(row['failure_count']) || 0;
      source.total_timeouts += Number(row['timeout_count']) || 0;
      source.total_events += Number(row['event_count']) || 0;
      source.avg_latency_ms += Number(row['avg_latency_ms']) || 0;
      source.windows++;
    }

    for (const sourceName of Object.keys(bySource)) {
      const source = bySource[sourceName];
      source.success_rate =
        source.total_requests > 0
          ? ((source.total_successes / source.total_requests) * 100).toFixed(
              1,
            ) + '%'
          : 'N/A';
      source.avg_latency_ms =
        source.windows > 0
          ? Math.round(source.avg_latency_ms / source.windows)
          : 0;
    }

    return { sources: bySource };
  }
}
