-- 0.2.0: semantic search over PostgREST, so tools need no direct SQL access.
-- POST /rpc/search_notes {"query_embedding": "[...768 floats...]", "match_count": 10}
-- Runs as the caller (note_writer after check_bearer_token), so it can read
-- no more than GET /notes can. match_count is clamped to 1..100.
create index if not exists notes_embedding_idx on notes using hnsw (embedding vector_cosine_ops);

create or replace function public.search_notes(query_embedding vector(768), match_count integer default 10)
returns table (id uuid, path text, content text, content_hash text, mtime bigint, size integer, deleted boolean, score double precision)
language sql stable
as $$
  select n.id, n.path, n.content, n.content_hash, n.mtime, n.size, n.deleted,
         1 - (n.embedding <=> query_embedding) as score
  from public.notes n
  where not n.deleted and n.embedding is not null
  order by n.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 10), 1), 100)
$$;

revoke execute on function public.search_notes(vector, integer) from public;
grant execute on function public.search_notes(vector, integer) to note_writer;

notify pgrst, 'reload schema';
