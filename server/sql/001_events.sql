-- Enable PostGIS (safe to re-run)
create extension if not exists postgis;
create extension if not exists pg_trgm;

create table if not exists events (
  id                             uuid primary key default gen_random_uuid(),

  -- source tracking
  source                         text not null,
  source_event_id                text not null,
  source_parent_id               text,
  source_url                     text,
  source_type                    text not null default 'ticketing_api',
  record_kind                    text not null default 'event',
  merged_sources                 text[] not null default '{}',
  merged_into                    uuid references events(id) on delete set null,
  source_confidence              numeric,

  -- content
  title                          text not null,
  short_description              text,
  full_description               text,
  category                       text,
  subcategory                    text,
  event_type                     text not null,

  -- time
  start_at_utc                   timestamptz,
  end_at_utc                     timestamptz,
  start_local                    text,
  end_local                      text,
  timezone                       text,
  sales_start_at_utc             timestamptz,
  sales_end_at_utc               timestamptz,

  -- location
  venue_name                     text,
  venue_id                       text,
  address_line1                  text,
  address_line2                  text,
  city                           text,
  state                          text,
  postal_code                    text,
  country                        text,
  neighborhood                   text,
  latitude                       double precision,
  longitude                      double precision,
  geom                           geography(Point, 4326)
                                 generated always as (
                                   case
                                     when latitude is not null and longitude is not null
                                     then st_setsrid(st_makepoint(longitude, latitude), 4326)::geography
                                     else null
                                   end
                                 ) stored,
  geohash                        text,

  -- media / presentation
  image_url                      text,
  status                         text not null default 'scheduled',
  availability_status            text,
  urgency_badge                  text,

  -- pricing
  price_min                      numeric,
  price_max                      numeric,
  currency                       text,
  cover_price                    numeric,
  table_min_price                numeric,

  -- popularity / social
  social_proof_count             integer,
  social_proof_label             text,
  venue_popularity_count         integer,
  venue_rating                   numeric,
  ticket_provider_count          integer,
  popularity_score_raw           numeric,
  venue_signal_score             numeric,
  exclusivity_score              numeric,
  trending_score                 numeric,
  cross_source_confirmation_score numeric,

  -- organizer
  organizer_name                 text,
  organizer_event_count          integer,
  organizer_verified             boolean,

  -- race
  race_type                      text,
  distance_value                 numeric,
  distance_unit                  text,

  -- nightlife / venue
  artists_or_teams               text[] not null default '{}',
  registration_url               text,
  ticket_url                     text,
  reservation_url                text,
  age_minimum                    integer,
  door_policy_text               text,
  dress_code_text                text,
  guest_list_available           boolean,
  bottle_service_available       boolean,
  opening_hours_text             text,
  entry_policy_summary           text,
  women_entry_policy_text        text,
  men_entry_policy_text          text,
  exclusivity_tier_label         text,

  -- indexing / dedup
  dedup_hash                     text not null,
  tags                           text[] not null default '{}',
  search_tsv                     tsvector,

  -- lifecycle
  raw_payload                    jsonb not null default '{}'::jsonb,
  ingested_at                    timestamptz not null default now(),
  last_seen_at                   timestamptz not null default now(),
  source_updated_at              timestamptz
);

-- Identity: one row per raw source event
create unique index if not exists events_source_uid
  on events(source, source_event_id);

-- Viewport queries
create index if not exists events_geom_gix
  on events using gist(geom)
  where merged_into is null;

create index if not exists events_geohash_idx
  on events(geohash)
  where merged_into is null;

-- Time filtering
create index if not exists events_start_at_idx
  on events(start_at_utc)
  where start_at_utc is not null and merged_into is null;

-- Dedup bucket
create index if not exists events_dedup_hash_idx
  on events(dedup_hash)
  where merged_into is null;

-- Full-text search
create index if not exists events_search_gin
  on events using gin(search_tsv);

create index if not exists events_title_trgm
  on events using gin(title gin_trgm_ops);

-- Keep search_tsv + last_seen_at in sync
create or replace function events_set_search_tsv() returns trigger as $$
begin
  new.search_tsv :=
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.venue_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(new.city, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(new.category, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.subcategory, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.short_description, '')), 'D');
  new.last_seen_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_events_search_tsv on events;
create trigger trg_events_search_tsv
  before insert or update on events
  for each row execute function events_set_search_tsv();
