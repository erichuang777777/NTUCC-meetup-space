\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-000000000001','admin@example.test'),
('00000000-0000-4000-8000-000000000002','member@example.test'),
('00000000-0000-4000-8000-000000000003','invitee@example.test'),
('00000000-0000-4000-8000-000000000004','wrong@example.test'),
('00000000-0000-4000-8000-000000000005','other-admin@example.test'),
('00000000-0000-4000-8000-000000000006','nongoogle@example.test');
update profiles set role='admin',passcode_verified=true where id in ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005');
update profiles set passcode_verified=true where id='00000000-0000-4000-8000-000000000002';
update auth.users set raw_app_meta_data='{"provider":"email","providers":["email"]}' where id='00000000-0000-4000-8000-000000000006';
set local role service_role;
do $$begin
 begin perform set_member_role('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','admin');raise exception 'Member elevated another user';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform set_member_role('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','member');raise exception 'Self demotion accepted';exception when raise_exception then if sqlerrm<>'SELF_ROLE_CHANGE_FORBIDDEN' then raise;end if;end;
end$$;
select set_member_role('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','admin');
select set_member_role('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','member');
do $$begin
 begin perform set_member_role('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','member');raise exception 'Stale admin session changed a role';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
end$$;
select create_member_invitation('00000000-0000-4000-8000-000000000001','invitee@example.test','member',repeat('a',64));
do $$begin
 begin perform accept_member_invitation('00000000-0000-4000-8000-000000000004',repeat('a',64));raise exception 'Wrong Google account accepted';exception when raise_exception then if sqlerrm<>'INVITE_ACCOUNT_MISMATCH' then raise;end if;end;
end$$;
select accept_member_invitation('00000000-0000-4000-8000-000000000003',repeat('a',64));
select accept_member_invitation('00000000-0000-4000-8000-000000000003',repeat('a',64));
do $$begin if not (select passcode_verified from profiles where id='00000000-0000-4000-8000-000000000003') then raise exception 'Invitation did not activate member';end if;if(select count(*) from member_admin_events where event='invite_accepted')<>1 then raise exception 'Acceptance retried non-idempotently';end if;end$$;
select create_member_invitation('00000000-0000-4000-8000-000000000001','nongoogle@example.test','member',repeat('b',64));
do $$begin begin perform accept_member_invitation('00000000-0000-4000-8000-000000000006',repeat('b',64));raise exception 'Non-Google account accepted';exception when raise_exception then if sqlerrm<>'GOOGLE_LOGIN_REQUIRED' then raise;end if;end;end$$;
select create_member_invitation('00000000-0000-4000-8000-000000000001','wrong@example.test','admin',repeat('c',64));
select revoke_member_invitation('00000000-0000-4000-8000-000000000001',(select id from member_invitations where token_hash=repeat('c',64)));
do $$begin begin perform accept_member_invitation('00000000-0000-4000-8000-000000000004',repeat('c',64));raise exception 'Revoked invite accepted';exception when raise_exception then if sqlerrm<>'INVITATION_INVALID' then raise;end if;end;end$$;
select create_member_invitation('00000000-0000-4000-8000-000000000001','wrong@example.test','admin',repeat('d',64));
select create_member_invitation('00000000-0000-4000-8000-000000000001','wrong@example.test','admin',repeat('e',64));
do $$begin if not exists(select 1 from member_invitations where token_hash=repeat('d',64) and revoked_at is not null) then raise exception 'Resend did not invalidate old link';end if;end$$;
select accept_member_invitation('00000000-0000-4000-8000-000000000004',repeat('e',64));
do $$begin if not exists(select 1 from profiles where id='00000000-0000-4000-8000-000000000004' and role='admin' and passcode_verified) then raise exception 'Admin invite was not applied';end if;end$$;
select create_member_invitation('00000000-0000-4000-8000-000000000001','other-admin@example.test','member',repeat('f',64));
select accept_member_invitation('00000000-0000-4000-8000-000000000005',repeat('f',64));
do $$begin if(select role from profiles where id='00000000-0000-4000-8000-000000000005')<>'admin' then raise exception 'Member invite demoted existing admin';end if;end$$;
reset role;
update member_invitations set expires_at=now()-interval '1 day' where token_hash=repeat('b',64);
update auth.users set raw_app_meta_data='{"provider":"google","providers":["google"]}' where id='00000000-0000-4000-8000-000000000006';
do $$begin begin perform accept_member_invitation('00000000-0000-4000-8000-000000000006',repeat('b',64));raise exception 'Expired invite accepted';exception when raise_exception then if sqlerrm<>'INVITATION_INVALID' then raise;end if;end;end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$begin if exists(select id from member_invitations) then raise exception 'Member read invitations';end if;
 begin perform token_hash from member_invitations;raise exception 'Invitation hashes exposed';exception when insufficient_privilege then null;end;
 begin perform set_member_role(auth.uid(),auth.uid(),'admin');raise exception 'Direct role RPC allowed';exception when insufficient_privilege then null;end;
 begin perform accept_member_invitation(auth.uid(),repeat('a',64));raise exception 'Direct invitation RPC allowed';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$begin if not exists(select id from member_invitations) then raise exception 'Admin cannot read invitation metadata';end if;begin perform token_hash from member_invitations;raise exception 'Admin client can read invite hashes';exception when insufficient_privilege then null;end;end$$;
rollback;
