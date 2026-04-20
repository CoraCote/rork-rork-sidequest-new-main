export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
  },
  worker: {
    id: process.env.WORKER_ID || `worker-${process.pid}-${Date.now()}`,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '8000', 10),
    heartbeatIntervalMs: parseInt(
      process.env.HEARTBEAT_INTERVAL_MS || '30000',
      10,
    ),
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '5', 10),
    heartbeatTimeoutMinutes: parseInt(
      process.env.HEARTBEAT_TIMEOUT_MINUTES || '5',
      10,
    ),
  },
  apiKeys: {
    ticketmaster: process.env.TICKETMASTER_API_KEY,
    eventbrite: process.env.EVENTBRITE_PRIVATE_TOKEN,
    apify: process.env.APIFY_API_TOKEN,
    yelp: process.env.YELP_API_KEY,
  },
});
