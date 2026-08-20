/**
 * Usage:
 *   npm run ingest -- --document <knowledge_documents.id> --file path/to/text.txt [--chunk-size 3]
 *   npm run ingest -- --document <knowledge_documents.id> --text "some course text" [--chunk-size 3]
 */
import { readFileSync, existsSync } from "node:fs";
import { embed } from "../lib/voyage";
import { getSupabaseServiceClient } from "../lib/supabase";

process.loadEnvFile(".env.local");

// Kept small so a batch's total tokens stay comfortably under Voyage's
// 10K-tokens-per-minute cap for accounts without a payment method on file.
const BATCH_SIZE = 20;
// Voyage's no-payment-method tier allows 3 requests/minute; space calls
// out to stay under that instead of bursting and hitting 429s.
const MIN_REQUEST_INTERVAL_MS = 21_000;
const MAX_RETRIES = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function chunkText(text: string, paragraphsPerChunk: number): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (let i = 0; i < paragraphs.length; i += paragraphsPerChunk) {
    chunks.push(paragraphs.slice(i, i + paragraphsPerChunk).join("\n\n"));
  }
  return chunks;
}

async function embedChunks(chunks: string[]): Promise<number[][]> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await embed(chunks, "document");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const is429 = message.includes("Voyage AI request failed (429)");

      if (is429 && attempt < MAX_RETRIES) {
        console.log(`Rate limited (attempt ${attempt}/${MAX_RETRIES}). Waiting ${Math.round(MIN_REQUEST_INTERVAL_MS / 1000)}s before retry...`);
        await sleep(MIN_REQUEST_INTERVAL_MS);
        continue;
      }

      throw err;
    }
  }

  throw new Error("Voyage AI request failed after max retries.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.document) {
    console.error("Missing required --document <knowledge_documents.id>");
    process.exit(1);
  }
  if (!args.file && !args.text) {
    console.error("Provide course text via --file <path> or --text <string>");
    process.exit(1);
  }

  const text = args.file
    ? (() => {
        if (!existsSync(args.file)) {
          console.error(`File not found: ${args.file}`);
          process.exit(1);
        }
        return readFileSync(args.file, "utf-8");
      })()
    : args.text;

  const paragraphsPerChunk = args["chunk-size"] ? parseInt(args["chunk-size"], 10) : 3;
  const chunks = chunkText(text, paragraphsPerChunk);

  if (chunks.length === 0) {
    console.error("No text content found to chunk.");
    process.exit(1);
  }

  console.log(`Split input into ${chunks.length} chunk(s) of ~${paragraphsPerChunk} paragraph(s) each.`);

  const supabase = getSupabaseServiceClient();
  const chunkBatches = batch(chunks, BATCH_SIZE);
  let inserted = 0;

  for (let i = 0; i < chunkBatches.length; i++) {
    if (i > 0) {
      console.log(`Waiting ${Math.round(MIN_REQUEST_INTERVAL_MS / 1000)}s to stay under Voyage's rate limit...`);
      await sleep(MIN_REQUEST_INTERVAL_MS);
    }

    const batchChunks = chunkBatches[i];
    console.log(`Batch ${i + 1}/${chunkBatches.length}: embedding ${batchChunks.length} chunk(s) via Voyage AI...`);
    const embeddings = await embedChunks(batchChunks);

    const rows = batchChunks.map((content, j) => ({
      document_id: args.document,
      content,
      embedding: embeddings[j],
    }));

    const { data, error } = await supabase.from("knowledge_chunks").insert(rows).select("id");

    if (error) {
      console.error(`Insert failed on batch ${i + 1}:`, error.message);
      console.error(`${inserted} chunk(s) were already inserted before this failure.`);
      process.exit(1);
    }

    inserted += data.length;
    console.log(`Batch ${i + 1}/${chunkBatches.length}: inserted (${inserted}/${chunks.length} total).`);
  }

  console.log(`Done. Inserted ${inserted} chunk(s) into knowledge_chunks for document ${args.document}.`);
}

main();
