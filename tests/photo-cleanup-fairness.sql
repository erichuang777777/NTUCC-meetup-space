-- Disposable DB only: failures in the first batch cannot starve untouched rows.
begin;
insert into event_photo_cleanup(object_path,status,created_at)
select 'ab000000-0000-4000-8000-000000000001/ab000000-0000-4000-8000-000000000002/'||('ab000000-0000-4000-8000-'||lpad(n::text,12,'0'))||'.png','pending',now()-interval '30 days'+n*interval '1 second' from generate_series(1,26) n;
do $$declare q record; first_count integer:=0;found_last boolean:=false;begin
 for q in select * from pending_event_photo_cleanup() loop
  first_count:=first_count+1;
  perform record_event_photo_cleanup(q.id,false);
 end loop;
 if first_count<>25 then raise exception 'Cleanup not bounded to 25';end if;
 for q in select * from pending_event_photo_cleanup() loop
  if q.object_path like '%/ab000000-0000-4000-8000-000000000026.png' then found_last:=true;end if;
 end loop;
 if not found_last then raise exception 'Repeated failures starved untouched cleanup';end if;
end$$;
rollback;
