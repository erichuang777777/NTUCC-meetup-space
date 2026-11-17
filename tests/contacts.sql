\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-000000000001','sender@example.test'),
('00000000-0000-4000-8000-000000000002','recipient@example.test'),
('00000000-0000-4000-8000-000000000003','admin@example.test'),
('00000000-0000-4000-8000-000000000004','pending@example.test');
update profiles set passcode_verified=true where id<>'00000000-0000-4000-8000-000000000004';
update profiles set role='admin' where id='00000000-0000-4000-8000-000000000003';
insert into spaces(id,owner_id,title,summary,visibility) values
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Public project','Test','public'),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Private project','Test','private');
insert into user_api_tokens(user_id,token_prefix,token_hash) values('00000000-0000-4000-8000-000000000001','ntucc_sk_test','test-hash');
do $$begin if exists(select 1 from user_api_tokens where scopes && array['messages:read','messages:write']) then raise exception 'Existing/default tokens acquired private-message scope';end if;end$$;
set local role service_role;
select send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Hello','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');
select send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Hello','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');
do $$begin if(select count(*) from private_messages)<>1 then raise exception 'Retry duplicated a message';end if;
 begin perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Different','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');raise exception 'Idempotency conflict accepted';exception when raise_exception then if sqlerrm<>'IDEMPOTENCY_CONFLICT' then raise;end if;end;
 begin perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Self',null,null);raise exception 'Self contact accepted';exception when raise_exception then if sqlerrm<>'CONTACT_UNAVAILABLE' then raise;end if;end;
 begin perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Private context','10000000-0000-4000-8000-000000000002',null);raise exception 'Private project context exposed';exception when raise_exception then if sqlerrm<>'PROJECT_NOT_FOUND' then raise;end if;end;
end$$;
reset role;
set local role anon;
do $$begin begin perform * from private_messages;raise exception 'Guest can read messages';exception when insufficient_privilege then null;end;end$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$begin if(select count(*) from private_conversations)<>1 or (select count(*) from private_messages)<>1 then raise exception 'Sender cannot read own conversation';end if;
 begin perform send_private_message(auth.uid(),'00000000-0000-4000-8000-000000000002','Bypass',null,null);raise exception 'Direct RPC bypassed PII';exception when insufficient_privilege then null;end;
 begin insert into private_messages(conversation_id,sender_id,body) select id,auth.uid(),'Bypass' from private_conversations;raise exception 'Direct write bypassed PII';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$begin if(select count(*) from private_messages)<>1 then raise exception 'Recipient cannot read own conversation';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
do $$begin if exists(select 1 from private_conversations) or exists(select 1 from private_messages) then raise exception 'Admin can read someone else private conversation';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
do $$begin if exists(select 1 from private_messages) then raise exception 'Pending user can read messages';end if;end$$;
reset role;
update profiles set accepts_messages=false where id='00000000-0000-4000-8000-000000000002';
do $$begin begin perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Optout',null,null);raise exception 'Optout ignored';exception when raise_exception then if sqlerrm<>'CONTACT_UNAVAILABLE' then raise;end if;end;end$$;
update profiles set accepts_messages=true where id='00000000-0000-4000-8000-000000000002';
select set_contact_block('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',true);
do $$begin begin perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Blocked',null,null);raise exception 'Block ignored';exception when raise_exception then if sqlerrm<>'CONTACT_UNAVAILABLE' then raise;end if;end;
 begin perform send_private_message('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Reverse blocked',null,null);raise exception 'Reverse block ignored';exception when raise_exception then if sqlerrm<>'CONTACT_UNAVAILABLE' then raise;end if;end;
end$$;
select set_contact_block('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',false);
do $$begin for i in 1..29 loop perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Quota test',null,null);end loop;
 begin perform send_private_message('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Over quota',null,null);raise exception 'Quota ignored';exception when raise_exception then if sqlerrm<>'RATE_LIMITED' then raise;end if;end;
end$$;
rollback;
