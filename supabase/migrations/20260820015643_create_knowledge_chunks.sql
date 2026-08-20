-- Ensure pgvector is available. Safe no-op if it's already enabled.
create extension if not exists vector;

-- knowledge_chunks: the retrievable units of a knowledge_documents row.
-- Each document is split into smaller passages ("chunks") of text, each
-- with its own embedding, so semantic search can find and cite the
-- specific passage relevant to a student's question rather than an
-- entire document.
create table if not exists knowledge_chunks (
  -- Surrogate primary key.
  id uuid primary key default gen_random_uuid(),

  -- The document this chunk was extracted from. Deleting a document
  -- cascades to its chunks, since a chunk has no meaning on its own.
  document_id uuid not null references knowledge_documents(id) on delete cascade,

  -- The chunk's raw text, what's retrieved and shown/cited to the model
  -- or student.
  content text not null,

  -- Semantic embedding of `content`, generated with Voyage AI's
  -- voyage-3-large model (1024 output dimensions). Used for vector
  -- similarity search at query time.
  embedding vector(1024),

  -- Whether this chunk actually contains an answer to a real student
  -- question (vs. being boilerplate, a heading, table of contents, etc.).
  -- Defaults to false; can be set true via review or evaluation tooling
  -- to prioritize high-value chunks in retrieval.
  answer_bearing boolean not null default false,

  -- When this chunk was created, for auditing/ingestion tracking.
  created_at timestamptz not null default now()
);

comment on table knowledge_chunks is
  'Embedded text passages extracted from knowledge_documents, used for semantic retrieval over course knowledge.';

-- Approximate nearest-neighbor index for fast cosine-similarity search
-- over embeddings. HNSW is pgvector's recommended index type for typical
-- retrieval workloads (build once, then query with the <=> operator).
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

-- Speeds up "all chunks for this document" lookups (e.g. re-indexing or
-- deleting a document's chunks).
create index if not exists knowledge_chunks_document_id_idx
  on knowledge_chunks (document_id);
