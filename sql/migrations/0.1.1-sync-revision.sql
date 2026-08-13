begin;

create sequence if not exists public.notes_sync_revision_seq;

alter table public.notes add column if not exists sync_revision bigint;

update public.notes
set sync_revision = nextval('public.notes_sync_revision_seq'::regclass)
where sync_revision is null;

select setval(
  'public.notes_sync_revision_seq'::regclass,
  greatest(coalesce(max(sync_revision), 0), 1),
  max(sync_revision) is not null
)
from public.notes;

create or replace function public.assign_note_sync_revision() returns trigger as $$
begin
  new.sync_revision := nextval('public.notes_sync_revision_seq'::regclass);
  return new;
end;
$$ language plpgsql security definer set search_path = pg_catalog;

alter function public.assign_note_sync_revision() owner to postgres;
revoke execute on function public.assign_note_sync_revision() from public;

drop trigger if exists notes_assign_sync_revision on public.notes;
create trigger notes_assign_sync_revision
before insert or update on public.notes
for each row execute function public.assign_note_sync_revision();

alter table public.notes alter column sync_revision set not null;
create unique index if not exists notes_sync_revision_idx on public.notes (sync_revision);

commit;
