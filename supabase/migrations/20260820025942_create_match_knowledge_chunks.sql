-- match_knowledge_chunks: nearest-neighbor search over knowledge_chunks for
-- a given course, used by /api/chat to retrieve the passages most relevant
-- to a student's question before asking Claude to answer from them.
--
-- Deliberately excludes chunks belonging to documents where
-- license_confirmed is false: this is the enforcement point for the
-- licensing gate described on knowledge_documents.license_confirmed
-- (source documents whose usage rights haven't been confirmed must not be
-- used to generate answers). A course with no license-confirmed documents
-- will simply retrieve zero chunks, which the caller should treat as "no
-- material available" rather than an error.
create or replace function match_knowledge_chunks(
  query_embedding vector(1024),
  match_course_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language sql stable
set search_path = public
as $$
  select
    kc.id,
    kc.document_id,
    kc.content,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_chunks kc
  join knowledge_documents kd on kd.id = kc.document_id
  where kd.course_id = match_course_id
    and kd.license_confirmed = true
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
