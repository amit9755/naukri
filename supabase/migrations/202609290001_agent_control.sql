-- Service-only data plane. Supabase Auth identities authorize server-side APIs.
create table public.agents (
 id uuid primary key, owner_id uuid not null references auth.users(id), name text not null check(length(name) between 1 and 80),
 machine_id text unique not null check(length(machine_id) <= 80), secret_hash text not null check(length(secret_hash)=64),
 status text not null default 'ONLINE' check(status in ('ONLINE','OFFLINE')),
 session_status text not null default 'UNKNOWN' check(session_status in ('UNKNOWN','SUCCESS','FAILED','AUTH_REQUIRED')),
 last_seen_at timestamptz, app_version text not null default '1.0.0', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.automation_config (
 id uuid primary key default gen_random_uuid(), agent_id uuid unique not null references public.agents(id) on delete cascade,
 enabled boolean not null default false, schedule_time time not null default '06:30' check(extract(second from schedule_time)=0), timezone text not null default 'Asia/Kolkata',
 catch_up boolean not null default true, account_label text not null default 'Configured locally on Windows', last_scheduled_date date,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.automation_commands (
 id uuid primary key default gen_random_uuid(), agent_id uuid not null references public.agents(id) on delete cascade,
 command text not null check(command='RUN_REFRESH'), status text not null default 'PENDING' check(status in ('PENDING','RUNNING','SUCCESS','FAILED','AUTH_REQUIRED')),
 source text not null check(source in ('MANUAL','SCHEDULED')), scheduled_date date, claim_key uuid,
 created_at timestamptz not null default now(), claimed_at timestamptz, completed_at timestamptz, result jsonb,
 check((source='SCHEDULED')=(scheduled_date is not null)), check(result is null or jsonb_typeof(result)='object')
);
create unique index one_active_refresh on public.automation_commands(agent_id) where status in ('PENDING','RUNNING');
create unique index one_scheduled_day on public.automation_commands(agent_id,scheduled_date) where source='SCHEDULED';
create unique index one_claim_key on public.automation_commands(agent_id,claim_key) where claim_key is not null;
create index command_history on public.automation_commands(agent_id,created_at desc);
create table public.automation_runs (
 id uuid primary key default gen_random_uuid(), agent_id uuid not null references public.agents(id) on delete cascade,
 command_id uuid unique references public.automation_commands(id), source text not null check(source in ('MANUAL','SCHEDULED')),
 started_at timestamptz not null default now(), finished_at timestamptz,
 status text not null check(status in ('RUNNING','SUCCESS','FAILED','AUTH_REQUIRED')), result jsonb, error_code text,
 created_at timestamptz not null default now(), check(result is null or jsonb_typeof(result)='object'),
 check(error_code is null or error_code in ('AUTH_REQUIRED','REFRESH_FAILED','CHROME_FAILED','AGENT_RESTARTED','STALE_RUNNING','INVALID_RESULT','EXECUTION_FAILED'))
);
create index run_history on public.automation_runs(agent_id,started_at desc);
create index agents_owner on public.agents(owner_id);
alter table public.agents enable row level security;
alter table public.automation_config enable row level security;
alter table public.automation_commands enable row level security;
alter table public.automation_runs enable row level security;
revoke all on public.agents, public.automation_config, public.automation_commands, public.automation_runs from anon, authenticated;
grant all on public.agents, public.automation_config, public.automation_commands, public.automation_runs to service_role;

create function public.register_agent(p_id uuid,p_owner uuid,p_machine text,p_name text,p_hash text,p_version text) returns uuid
language plpgsql security definer set search_path=public as $$
begin
 insert into agents(id,owner_id,machine_id,name,secret_hash,app_version,last_seen_at) values(p_id,p_owner,p_machine,p_name,p_hash,p_version,now()) on conflict(id) do nothing;
 if not exists(select 1 from agents where id=p_id and owner_id=p_owner and machine_id=p_machine and secret_hash=p_hash) then raise exception 'REGISTRATION_CONFLICT'; end if;
 insert into automation_config(agent_id) values(p_id) on conflict(agent_id) do nothing;
 return p_id;
end $$;

create function public.enqueue_refresh(p_agent uuid) returns public.automation_commands
language plpgsql security definer set search_path=public as $$
declare c automation_commands;
begin
 perform 1 from agents where id=p_agent for update;
 insert into automation_commands(agent_id,command,source) values(p_agent,'RUN_REFRESH','MANUAL') returning * into c;
 return c;
end $$;

-- Match Temporal's compatible disambiguation: earlier occurrence on an overlap,
-- forward by the gap on a skipped wall time. PostgreSQL defaults to the later
-- occurrence, so compare the preceding day's offset without assuming a 1h shift.
create function public.schedule_instant(p_local timestamp,p_zone text) returns timestamptz
language plpgsql stable set search_path=public as $$
declare target timestamptz; earlier timestamptz; previous timestamptz;
begin
 target := p_local at time zone p_zone;
 previous := target - interval '24 hours';
 earlier := target - (((previous at time zone p_zone)-(previous at time zone 'UTC'))
                    -((target at time zone p_zone)-(target at time zone 'UTC')));
 if earlier<target and (earlier at time zone p_zone)=p_local then return earlier; end if;
 return target;
end $$;
revoke all on function public.schedule_instant(timestamp,text) from public,anon,authenticated;
grant execute on function public.schedule_instant(timestamp,text) to service_role;

create function public.claim_refresh(p_agent uuid,p_key uuid,p_day date default null) returns setof public.automation_commands
language plpgsql security definer set search_path=public as $$
declare cfg automation_config; c automation_commands; local_now timestamp; target timestamptz;
begin
 perform 1 from agents where id=p_agent for update;
 -- Lost claim responses are replayed by key; never allocate a second command.
 if exists(select 1 from automation_commands where agent_id=p_agent and claim_key=p_key) then
  return query select * from automation_commands where agent_id=p_agent and claim_key=p_key; return;
 end if;
 select * into cfg from automation_config where agent_id=p_agent for update;
 local_now := now() at time zone cfg.timezone;
 target := schedule_instant(local_now::date + cfg.schedule_time,cfg.timezone);
 if p_day is not null and cfg.enabled and p_day=local_now::date and (cfg.last_scheduled_date is null or cfg.last_scheduled_date<p_day)
   and now()>=target and (cfg.catch_up or now()<target+interval '1 minute')
   and not exists(select 1 from automation_commands where agent_id=p_agent and status in ('PENDING','RUNNING')) then
  insert into automation_commands(agent_id,command,source,scheduled_date) values(p_agent,'RUN_REFRESH','SCHEDULED',p_day) on conflict do nothing;
  if exists(select 1 from automation_commands where agent_id=p_agent and scheduled_date=p_day) then
   update automation_config set last_scheduled_date=p_day,updated_at=now() where agent_id=p_agent;
  end if;
 end if;
 select * into c from automation_commands where agent_id=p_agent and status='PENDING' order by created_at limit 1 for update skip locked;
 if c.id is null then return; end if;
 update automation_commands set status='RUNNING',claimed_at=now(),claim_key=p_key where id=c.id returning * into c;
 insert into automation_runs(agent_id,command_id,source,status) values(p_agent,c.id,c.source,'RUNNING');
 return next c;
end $$;

create function public.complete_refresh(p_agent uuid,p_command uuid,p_status text,p_result jsonb,p_error text) returns boolean
language plpgsql security definer set search_path=public as $$
declare c automation_commands;
begin
 if p_status not in ('SUCCESS','FAILED','AUTH_REQUIRED') then raise exception 'INVALID_STATUS'; end if;
 select * into c from automation_commands where id=p_command and agent_id=p_agent for update;
 if c.id is null then raise exception 'NOT_FOUND'; end if;
 if c.status in ('SUCCESS','FAILED','AUTH_REQUIRED') then return true; end if;
 if c.status<>'RUNNING' then raise exception 'NOT_RUNNING'; end if;
 update automation_commands set status=p_status,completed_at=now(),result=p_result where id=c.id;
 update automation_runs set status=p_status,finished_at=now(),result=p_result,error_code=p_error where command_id=c.id;
 update agents set session_status=p_status,updated_at=now() where id=p_agent;
 return true;
end $$;

create function public.reconcile_stale(p_agent uuid) returns integer
language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 -- Terminalize uncertainty, never requeue. Operator must inspect before a new run.
 with stale as (
  update automation_commands set status='FAILED',completed_at=now(),result='{"success":false,"saveAttempted":true,"originalNamePreserved":null,"verifiedAfterReload":false,"refreshTimestampVerified":false}'::jsonb
  where agent_id=p_agent and status='RUNNING' and claimed_at<now()-interval '30 minutes' returning id,result
 ) update automation_runs r set status='FAILED',finished_at=now(),result=s.result,error_code='STALE_RUNNING' from stale s where r.command_id=s.id;
 get diagnostics n=row_count;
 if n>0 then update automation_config set enabled=false,updated_at=now() where agent_id=p_agent; end if;
 return n;
end $$;
revoke all on function public.register_agent(uuid,uuid,text,text,text,text), public.enqueue_refresh(uuid), public.claim_refresh(uuid,uuid,date), public.complete_refresh(uuid,uuid,text,jsonb,text), public.reconcile_stale(uuid) from public,anon,authenticated;
grant execute on function public.register_agent(uuid,uuid,text,text,text,text), public.enqueue_refresh(uuid), public.claim_refresh(uuid,uuid,date), public.complete_refresh(uuid,uuid,text,jsonb,text), public.reconcile_stale(uuid) to service_role;
