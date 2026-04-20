import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().default(4800),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  WORKER_ID: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().default(8000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(30000),
  MAX_CONCURRENT_JOBS: z.coerce.number().default(5),
  HEARTBEAT_TIMEOUT_MINUTES: z.coerce.number().default(5),

  TICKETMASTER_API_KEY: z.string(),
});

export type Env = z.infer<typeof envSchema>;
