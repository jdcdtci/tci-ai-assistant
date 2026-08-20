-- Excludes answer_bearing chunks (graded assignment/activity prompts with
-- their own specific scenario and required deliverable) from retrieval.
-- These were previously retrievable like any other course content, which
-- let the model perform a graded assignment's task live in a chat response
-- when a student's question happened to land near it semantically -- a
-- confirmed academic-integrity leak, not a hypothetical one. Retrieval
-- correctness isn't the issue: this content should never have been
-- eligible as freely-quotable grounding material in the first place.
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
    and kc.answer_bearing = false
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;
