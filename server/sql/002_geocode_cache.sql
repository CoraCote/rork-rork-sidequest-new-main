create table if not exists geocode_cache (
  id              uuid primary key default gen_random_uuid(),

  query_hash      text not null unique,
  query_text      text not null,
  provider        text not null default 'nominatim',

  latitude        double precision,
  longitude       double precision,
  display_name    text,

  house_number    text,
  road            text,
  neighbourhood   text,
  city            text,
  county          text,
  state           text,
  postal_code     text,
  country         text,
  country_code    text,

  osm_type        text,
  osm_id          bigint,
  place_id        bigint,
  place_rank      integer,
  importance      numeric,
  bbox            numeric[],

  raw             jsonb not null default '{}'::jsonb,

  hit_count       integer not null default 1,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now(),
  expires_at      timestamptz
);

create index if not exists geocode_cache_hash_idx on geocode_cache(query_hash);
create index if not exists geocode_cache_last_used_idx on geocode_cache(last_used_at);
create index if not exists geocode_cache_ll_idx
  on geocode_cache(latitude, longitude)
  where latitude is not null and longitude is not null;
