-- Disposable database only, after migrations 001..011 and Storage test bootstrap.
begin;
insert into auth.users(id,email) values ('fa000000-0000-4000-8000-000000000001','owner@example.test'),('fa000000-0000-4000-8000-000000000002','admin@example.test'),('fa000000-0000-4000-8000-000000000003','other@example.test');
update profiles set role='admin',passcode_verified=true where id='fa000000-0000-4000-8000-000000000002';
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('fb000000-0000-4000-8000-000000000001','Lifecycle test',now()+interval '1 hour',now()+interval '2 hours',now()+interval '30 minutes',10,true);
select submit_event_application('fa000000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001','姓名','台大','personal@example.test');
do $$
#variable_conflict use_variable
declare owner_id uuid:='fa000000-0000-4000-8000-000000000001'; admin_id uuid:='fa000000-0000-4000-8000-000000000002';event_id uuid:='fb000000-0000-4000-8000-000000000001';photo_id uuid:='fc000000-0000-4000-8000-000000000001';path text:='fb000000-0000-4000-8000-000000000001/fa000000-0000-4000-8000-000000000001/fc000000-0000-4000-8000-000000000001.png';q uuid;r jsonb; n integer;extra_id uuid;extra_path text;begin
 if has_function_privilege('authenticated','public.change_event_photo(uuid,uuid,text,boolean,text,text,boolean)','EXECUTE') or has_table_privilege('anon','public.event_photo_cleanup','SELECT') then raise exception 'Lifecycle permission leak';end if;
 perform queue_event_photo_cleanup(path,true);
 perform add_pending_event_photo(photo_id,owner_id,event_id,path,'caption',1,1,80);
 if (select publication_consent from event_photos where id=photo_id) then raise exception 'Implicit public consent';end if;
 -- Recovery recognizes a committed metadata row and never queues its storage for removal.
 perform pending_event_photo_cleanup();
 if (select status from event_photo_cleanup where object_path=path)<>'retained' then raise exception 'Live upload not protected';end if;
 begin perform change_event_photo(photo_id,admin_id,'publish',null,'public_web','checked',true);raise exception 'FAIL no consent';exception when others then if SQLERRM<>'PUBLICATION_CONSENT_REQUIRED' then raise;end if;end;
 begin perform change_event_photo(photo_id,admin_id,'consent',true,'public_web');raise exception 'FAIL admin consent';exception when others then if SQLERRM<>'PHOTO_NOT_FOUND' then raise;end if;end;
 begin perform change_event_photo(photo_id,owner_id,'publish',null,'public_web','checked',true);raise exception 'FAIL owner publish';exception when others then if SQLERRM<>'ADMIN_REQUIRED' then raise;end if;end;
 perform change_event_photo(photo_id,owner_id,'consent',true,'public_web');
 select count(*) into n from event_photo_audit;
 perform change_event_photo(photo_id,owner_id,'consent',true,'public_web');
 if (select count(*) from event_photo_audit)<>n then raise exception 'Repeated consent created audit';end if;
 begin perform change_event_photo(photo_id,admin_id,'publish',null,'public_web','checked',false);raise exception 'FAIL no human review';exception when others then if SQLERRM<>'PHOTO_REVIEW_REQUIRED' then raise;end if;end;
 perform change_event_photo(photo_id,admin_id,'publish',null,'public_web','Reviewed consent and visible contents',true);
 select count(*) into n from event_photo_audit;
 perform change_event_photo(photo_id,admin_id,'publish',null,'public_web','Reviewed consent and visible contents',true);
 if (select count(*) from event_photo_audit)<>n then raise exception 'Repeated review created audit';end if;
 if not exists(select 1 from event_photos p join public_events e on e.id=p.event_id where p.id=photo_id and p.status='published' and p.publication_consent and p.audience='public_web' and e.is_published) then raise exception 'Not public after approval';end if;
 update public_events set is_published=false where id=event_id;
 if exists(select 1 from event_photos p join public_events e on e.id=p.event_id where p.id=photo_id and p.status='published' and e.is_published) then raise exception 'Hidden event leaks photo';end if;
 update public_events set is_published=true where id=event_id;
 perform change_event_photo(photo_id,owner_id,'consent',false,'public_web');
 if (select status from event_photos where id=photo_id)<>'pending' then raise exception 'Consent revoke did not unpublish';end if;
 perform change_event_photo(photo_id,admin_id,'return',null,null,'Please confirm participant consent',true);
 if (select status from event_photos where id=photo_id)<>'returned' then raise exception 'Return failed';end if;
 perform change_event_photo(photo_id,owner_id,'withdraw');
 perform change_event_photo(photo_id,owner_id,'withdraw');
 if (select count(*) from event_photo_audit where event_photo_audit.photo_id=photo_id and action='withdraw')<>1 then raise exception 'Withdraw not idempotent';end if;
 select id into q from event_photo_cleanup where object_path=path;
 perform record_event_photo_cleanup(q,false);
 if (select status from event_photo_cleanup where id=q)<>'pending' then raise exception 'Failed removal not retryable';end if;
 perform record_event_photo_cleanup(q,true);
 if not exists(select 1 from event_photos where id=photo_id and storage_deleted_at is not null and status='withdrawn' and caption='' and review_reason is null) then raise exception 'Cleanup not recorded';end if;
 begin perform change_event_photo(photo_id,admin_id,'publish',null,'public_web','reviewed',true);raise exception 'FAIL republish withdrawn';exception when others then if SQLERRM<>'PHOTO_WITHDRAWN' then raise;end if;end;
 -- An upload intent with no metadata is only claimable after ten minutes.
 path:='fb000000-0000-4000-8000-000000000001/fa000000-0000-4000-8000-000000000001/fc000000-0000-4000-8000-000000000002.png';
 perform queue_event_photo_cleanup(path,true);
 perform pending_event_photo_cleanup();
 if (select status from event_photo_cleanup where object_path=path)<>'intent' then raise exception 'In-flight intent reclaimed early';end if;
 update event_photo_cleanup set created_at=now()-interval '11 minutes' where object_path=path;
 perform pending_event_photo_cleanup();
 begin perform add_pending_event_photo('fc000000-0000-4000-8000-000000000002',owner_id,event_id,path,'',1,1,80);raise exception 'FAIL late finalize';exception when others then if SQLERRM<>'UPLOAD_INTENT_EXPIRED' then raise;end if;end;
 -- Cascading deletion queues private objects before metadata disappears.
 path:='fb000000-0000-4000-8000-000000000001/fa000000-0000-4000-8000-000000000001/fc000000-0000-4000-8000-000000000003.png';
 perform queue_event_photo_cleanup(path,true);
 perform add_pending_event_photo('fc000000-0000-4000-8000-000000000003',owner_id,event_id,path,'',1,1,80);
 -- Ten not-yet-deleted objects consume quota; withdrawal alone does not free it.
 for n in 1..9 loop
  extra_id:=gen_random_uuid();extra_path:=event_id::text||'/'||owner_id::text||'/'||extra_id::text||'.png';
  perform queue_event_photo_cleanup(extra_path,true);
  perform add_pending_event_photo(extra_id,owner_id,event_id,extra_path,'',1,1,80);
 end loop;
 extra_id:=gen_random_uuid();extra_path:=event_id::text||'/'||owner_id::text||'/'||extra_id::text||'.png';
 perform queue_event_photo_cleanup(extra_path,true);
 perform change_event_photo('fc000000-0000-4000-8000-000000000003',owner_id,'withdraw');
 begin perform add_pending_event_photo(extra_id,owner_id,event_id,extra_path,'',1,1,80);raise exception 'FAIL pending deletion freed quota';exception when others then if SQLERRM<>'PHOTO_LIMIT' then raise;end if;end;
 select c.id into q from event_photo_cleanup c where c.object_path=path;
 perform record_event_photo_cleanup(q,true);
 perform add_pending_event_photo(extra_id,owner_id,event_id,extra_path,'',1,1,80);
 -- Keep a live object's path for cascade assertions.
 path:=extra_path;
 delete from public_events where id=event_id;
 if not exists(select 1 from event_photo_cleanup q where q.object_path=path and q.status='pending' and q.photo_id is null) then raise exception 'Cascade lost storage cleanup';end if;
 if not exists(select 1 from event_photo_audit where action='database_row_deleted') then raise exception 'Cascade lost audit';end if;
end$$;
rollback;
