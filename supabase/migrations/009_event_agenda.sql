-- Public agenda is explicitly editorial content, not an attendee list.
alter table public.public_events add column agenda jsonb not null default '[]'::jsonb;
alter table public.public_events add constraint event_agenda_array check(jsonb_typeof(agenda)='array' and jsonb_array_length(agenda)<=30);
