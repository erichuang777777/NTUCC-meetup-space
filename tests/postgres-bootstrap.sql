-- Disposable vanilla PostgreSQL only; never run on an existing Supabase project.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create schema extensions;
create schema vault;
create table vault.decrypted_secrets(name text,decrypted_secret text);
create publication supabase_realtime;
grant usage on schema public,auth to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to service_role;
