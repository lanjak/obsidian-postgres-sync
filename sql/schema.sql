-- Postgres + pgvector schema for obsidian-postgres-sync, exposed over PostgREST.
-- Run this against your Postgres instance, then point PostgREST at it with:
--   db-anon-role   = web_anon
--   db-pre-request = public.check_bearer_token
-- and connect PostgREST via a role (e.g. "authenticator") that is a member of
-- both web_anon and note_writer - see the role setup below.

create extension if not exists vector;

-- Single-row config table holding the API key the plugin must send.
-- Set your key with: update app_settings set bearer_token = 'your-long-random-key';
create table if not exists app_settings (
  id boolean primary key default true check (id),
  bearer_token text not null
);
insert into app_settings (id, bearer_token)
values (true, 'change-me')
on conflict (id) do nothing;

-- Embedding dimension below is 768 to match common local embedding models
-- (e.g. nomic-embed-text). Change this to match your embedding server's output
-- size BEFORE running this on a fresh database - pgvector's vector(N) size
-- cannot be changed once notes exist without dropping and recreating the
-- column (and losing existing embeddings).
--
-- id is a deterministic hash of path (see pathToId in src/postgrest.ts), so a
-- given path always maps to the same row - deleting and recreating a note at
-- the same path updates the existing (tombstoned) row instead of colliding
-- with anything, which is why there's no partial/unique constraint gymnastics
-- needed around `deleted`.
create table if not exists notes (
  id uuid primary key,
  path text not null,
  content text not null default '',
  content_hash text not null default '',
  mtime bigint not null,
  size integer not null default 0,
  deleted boolean not null default false,
  embedding vector(768)
);

create index if not exists notes_mtime_idx on notes (mtime);
create unique index if not exists notes_path_idx on notes (path);

-- Roles.
-- web_anon: what PostgREST connects requests as by default. No grants on
--   table data at all, so a dropped or misconfigured db-pre-request setting
--   fails closed on notes, not open. The credential itself is equally
--   unreachable: get_bearer_token() lives in the auth_priv schema (below),
--   which is never listed in PostgREST's db-schemas, so it is not routable
--   as a /rpc/<function> HTTP endpoint under any db-pre-request state -
--   web_anon's SQL-level execute grant on it only matters for the internal
--   call made by check_bearer_token(), not for direct HTTP access.
-- note_writer: full access to notes, reached only by check_bearer_token()
--   switching into it for the duration of a validated request.
-- authenticator: the role PostgREST's db-uri connects as. Must be a MEMBER of
--   both web_anon and note_writer so it's permitted to SET ROLE into either -
--   set_config('role', ...) fails for a role that isn't a member of the
--   target. This does NOT need to be, and should not be, a superuser.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'web_anon') then
    create role web_anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'note_writer') then
    create role note_writer nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin;
  end if;
end
$$;

grant web_anon to authenticator;
grant note_writer to authenticator;

grant usage on schema public to note_writer;
grant select, insert, update, delete on notes to note_writer;

-- Set a real login password for the role PostgREST connects as, if your
-- provisioning doesn't already manage this some other way:
-- alter role authenticator with login password 'set-a-real-password-here';

-- Private schema for auth internals - NOT listed in PostgREST's db-schemas config,
-- so nothing in here is ever routable as a /rpc/<function> HTTP endpoint, even if
-- db-pre-request is dropped or misconfigured. Verified empirically: with this
-- schema separation, /rpc/get_bearer_token returns 404 regardless of auth state;
-- without it, an unauthenticated caller can retrieve the plaintext key whenever
-- db-pre-request is unset (the exact misconfiguration this design is meant to survive).
create schema if not exists auth_priv;
revoke all on schema auth_priv from public;
grant usage on schema auth_priv to web_anon;

-- Auth check, split into two functions because SET ROLE (via set_config) is
-- disallowed inside a SECURITY DEFINER function. get_bearer_token() runs with
-- elevated rights just to read the configured key (web_anon has no direct
-- grant on app_settings); check_bearer_token() runs as the caller (web_anon)
-- and does the actual role switch.
create or replace function auth_priv.get_bearer_token() returns text as $$
  select bearer_token from app_settings where id = true;
$$ language sql security definer;

revoke execute on function auth_priv.get_bearer_token() from public;
grant execute on function auth_priv.get_bearer_token() to web_anon;

-- PostgREST maps a raised exception with SQLSTATE 'PT' + a 3-digit HTTP status
-- directly to that HTTP response ('PT401' -> HTTP 401). This is checked via a
-- custom X-Api-Key header, not Authorization - PostgREST tries to parse any
-- Authorization header as a JWT before db-pre-request even runs, and without
-- a configured JWT secret that fails with an unrelated 500 instead of ever
-- reaching this function.
create or replace function public.check_bearer_token() returns void as $$
declare
  headers json := current_setting('request.headers', true)::json;
  provided text := headers ->> 'x-api-key';
  expected text := auth_priv.get_bearer_token();
begin
  if expected is null or provided is null or provided <> expected then
    raise sqlstate 'PT401' using message = 'Invalid or missing API key';
  end if;
  perform set_config('role', 'note_writer', true);
end;
$$ language plpgsql;

revoke execute on function public.check_bearer_token() from public;
grant execute on function public.check_bearer_token() to web_anon;
