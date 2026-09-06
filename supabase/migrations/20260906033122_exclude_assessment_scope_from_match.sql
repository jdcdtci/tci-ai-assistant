-- Excludes published assessment scope blocks from retrieval.
--
-- THE HAZARD THIS CLOSES
--
-- MKTG365's course document contains "ASSESSMENT CONTENT / TOPICS COVERED"
-- blocks that enumerate exactly what a given graded assessment covers.
-- These were ordinary retrievable content, so the assistant would produce a
-- complete, itemized scope listing on request. Reproduced live before this
-- migration: asking "What topics are covered on the upcoming assessment
-- about experimental research and test markets?" returned the full list
-- (internal validity threats named individually, design types, test market
-- coverage, and so on), transcribed from the block.
--
-- That is a live guardrail gap, not a hypothetical one, because the
-- Section 3.8 assessment-mode flag does not exist yet. Nothing distinguishes
-- a student revising a week early from a student sitting inside the quiz
-- right now, so the same request served scope during a live assessment.
-- Knowing a quiz covers "internal validity threats: history, maturation,
-- selection bias, mortality, testing effects, and instrumentation" while
-- taking that quiz is a substantial narrowing aid.
--
-- Enforced here rather than by a system-prompt instruction telling the model
-- to avoid this content, following the same reasoning as answer_bearing and
-- RLS everywhere else in this project: a DB-layer guarantee holds regardless
-- of which future code path queries chunks, and does not depend on a model
-- holding an instruction against a persistent student.
--
-- WHY A SEPARATE FLAG FROM answer_bearing
--
-- answer_bearing tags graded assignment *prompts* (scenario plus required
-- deliverable), the content that once had the assistant performing an
-- assignment live. A scope listing is a different class: it reveals what an
-- assessment covers, not how to answer it. Keeping them separate preserves
-- the ability to ask which chunks were withheld for which reason, and keeps
-- the answer_bearing tag meaning one thing. Both are checked at query time.
--
-- NO OPT-IN PATH, DELIBERATELY
--
-- match_knowledge_chunks takes no parameter to include this content. A
-- feature to surface assessment scope to students has been requested but is
-- blocked on two open items (whether it can meet Section 3.8's
-- system-reported context requirement at all, and MKTG365's instructor's
-- decision on whether it should exist). Adding an opt-in now would be
-- building toward that feature ahead of both answers. If it is ever
-- approved, the opt-in gets designed then, with the identity and timing
-- problem solved first.

alter table public.knowledge_chunks
  add column if not exists assessment_scope boolean not null default false;

comment on column public.knowledge_chunks.assessment_scope is
  'True for published assessment scope blocks (ASSESSMENT CONTENT / TOPICS COVERED listings that enumerate what a graded assessment covers). Excluded from match_knowledge_chunks at the query layer, by default and with no opt-in path. Distinct from answer_bearing, which tags graded assignment prompts.';

-- Tagging criterion: the chunk BEGINS with one of the markers.
--
-- This distinction is load-bearing and was verified against the real data
-- before being applied. Sixteen chunks contain one of these markers, but
-- only seven are scope blocks. The other nine are ordinary teaching content
-- that merely ENDS with a trailing section header, because the ingest
-- chunker split the header away from the section it introduces. For example
-- one chunk closes a passage on screening problematic survey respondents and
-- then ends with the bare words "ASSESSMENT CONTENT"; the topics themselves
-- begin the following chunk. A naive `content like '%TOPICS COVERED%'` match
-- would have withheld nine chunks of legitimate course material and degraded
-- the assistant's actual teaching, which is precisely the outcome this
-- project's guardrails are supposed to avoid causing.
update public.knowledge_chunks
  set assessment_scope = true
  where content like 'TOPICS COVERED%'
     or content like 'ASSESSMENT CONTENT%';

-- Fail loudly rather than silently withholding the wrong set. If a
-- re-ingest changes the chunking, this count changes and the criterion needs
-- review before this migration is trusted again.
do $$
declare
  flagged int;
begin
  select count(*) into flagged from public.knowledge_chunks where assessment_scope;
  if flagged <> 7 then
    raise exception
      'Expected 7 assessment scope chunks, found %. Review the tagging criterion before proceeding rather than excluding the wrong chunks.',
      flagged;
  end if;
end $$;

-- Recreated with the additional filter. Existing license_confirmed and
-- answer_bearing filters are preserved exactly.
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
    and kc.assessment_scope = false
  order by kc.embedding <=> query_embedding
  limit match_count;
$$;

-- NOTE FOR RE-INGEST: like answer_bearing, this tagging does not happen
-- automatically. If MKTG365 content is ever re-ingested, both tags must be
-- reapplied, and the guard block above will fail loudly if the criterion no
-- longer matches seven chunks.
