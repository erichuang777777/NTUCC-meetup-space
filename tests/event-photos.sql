-- Disposable DB only, after 008, photo-storage-bootstrap.sql and 010.
begin;
insert into auth.users(id,email) values ('f9000000-0000-4000-8000-000000000001','photo@example.test');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('f9100000-0000-4000-8000-000000000001','Photo test',now()+interval '1 hour',now()+interval '2 hours',now()+interval '30 minutes',10,true);
select submit_event_application('f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001','參與者','台大測試','personal@example.test');
do $$declare new_id uuid; i integer; p text:='f9100000-0000-4000-8000-000000000001/f9000000-0000-4000-8000-000000000001/f9200000-0000-4000-8000-000000000001.png';begin
 if has_table_privilege('anon','public.event_photos','SELECT') or has_table_privilege('authenticated','public.event_photos','INSERT') or has_function_privilege('authenticated','public.add_pending_event_photo(uuid,uuid,uuid,text,text,integer,integer,integer)','EXECUTE') then raise exception 'Photo permission leak';end if;
 if (select public from storage.buckets where id='event-photos') then raise exception 'Public photo bucket';end if;
 perform add_pending_event_photo('f9200000-0000-4000-8000-000000000001','f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001',p,'安全照片',1,1,80);
 if (select status from event_photos where id='f9200000-0000-4000-8000-000000000001')<>'pending' then raise exception 'Not pending';end if;
 begin perform add_pending_event_photo(gen_random_uuid(),'f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001','other/path.png','',1,1,80);raise exception 'FAIL forged path';exception when others then if SQLERRM<>'INVALID_PHOTO_PATH' then raise;end if;end;
 for i in 1..9 loop
  new_id:=gen_random_uuid();
  perform add_pending_event_photo(new_id,'f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001/f9000000-0000-4000-8000-000000000001/'||new_id::text||'.png','',1,1,80);
 end loop;
 new_id:=gen_random_uuid();
 begin perform add_pending_event_photo(new_id,'f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001/f9000000-0000-4000-8000-000000000001/'||new_id::text||'.png','',1,1,80);raise exception 'FAIL limit';exception when others then if SQLERRM<>'PHOTO_LIMIT' then raise;end if;end;
 begin update event_photos set status='approved';raise exception 'FAIL public status';exception when check_violation then null;end;
 perform submit_event_application('f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001','','','',true);
 begin perform add_pending_event_photo('f9200000-0000-4000-8000-000000000002','f9000000-0000-4000-8000-000000000001','f9100000-0000-4000-8000-000000000001',p,'安全照片',1,1,80);raise exception 'FAIL cancelled upload';exception when others then if SQLERRM<>'REGISTRATION_REQUIRED' then raise;end if;end;
end$$;
insert into storage.objects(bucket_id,name) values ('event-photos','secret.png'),('other-bucket','allowed.png');
set local role authenticated;
do $$begin
 if exists(select 1 from storage.objects where bucket_id='event-photos') then raise exception 'Storage SELECT leak';end if;
 if not exists(select 1 from storage.objects where bucket_id='other-bucket') then raise exception 'Unrelated storage policy broken';end if;
 begin insert into storage.objects(bucket_id,name) values('event-photos','forged.png');raise exception 'FAIL storage insert';exception when insufficient_privilege then null;end;

end$$;
reset role;
set local role anon;
do $$declare affected integer;begin
 if exists(select 1 from storage.objects where bucket_id='event-photos') then raise exception 'Anon storage SELECT leak';end if;
 update storage.objects set name='changed' where bucket_id='event-photos';get diagnostics affected=row_count;
 if affected<>0 then raise exception 'Anon storage UPDATE leak';end if;
 delete from storage.objects where bucket_id='event-photos';get diagnostics affected=row_count;
 if affected<>0 then raise exception 'Anon storage DELETE leak';end if;
 begin insert into storage.objects(bucket_id,name) values('event-photos','forged.png');raise exception 'FAIL anon storage insert';exception when insufficient_privilege then null;end;
end$$;
reset role;
rollback;
