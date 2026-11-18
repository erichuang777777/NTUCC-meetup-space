-- Disposable vanilla PostgreSQL ONLY; never use on a real Supabase project.
-- Models Storage RLS with an intentionally broad legacy policy to prove our restrictive deny.
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon,authenticated,service_role;
grant all on storage.objects to anon,authenticated,service_role;
create policy legacy_broad_storage_policy on storage.objects for all to anon,authenticated using(true) with check(true);
