-- knowledge_documents: one row per source document that feeds a course's
-- knowledge base (e.g. a TCI textbook chapter or a teacher-supplied
-- supplementary reading). Each document is later split into embedded
-- chunks in knowledge_chunks. license_confirmed exists because
-- supplementary material may carry copyright/licensing restrictions that
-- must be explicitly cleared before its chunks are used to answer students.
create table if not exists knowledge_documents (
  -- Surrogate primary key, referenced by knowledge_chunks.document_id.
  id uuid primary key default gen_random_uuid(),

  -- The course this document belongs to. Kept as a plain uuid (no foreign
  -- key) since course records live outside this schema; add an FK
  -- constraint here once a local courses table exists to reference.
  course_id uuid not null,

  -- Where the content originated. "tci_content" is TCI's own curriculum
  -- material (pre-cleared for use); "supplementary" is outside material
  -- (e.g. teacher-uploaded) that requires license_confirmed before use.
  source_type text not null check (source_type in ('tci_content', 'supplementary')),

  -- Human-readable name of the source document, shown in citations/UI.
  title text not null,

  -- Whether this document's usage rights have been explicitly confirmed.
  -- Defaults to false so nothing is usable until someone reviews it;
  -- application/query logic should exclude chunks of unconfirmed
  -- documents from answer generation.
  license_confirmed boolean not null default false,

  -- When this document was registered, for auditing/ingestion tracking.
  created_at timestamptz not null default now()
);

comment on table knowledge_documents is
  'Source documents (TCI curriculum content or supplementary material) that are chunked and embedded for course knowledge retrieval.';
