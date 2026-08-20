// Shared Voyage AI embedding call, used by both the ingestion script and
// /api/chat so indexing and querying always use the identical model.
export const VOYAGE_MODEL = "voyage-3-large";

// "document" for text being indexed (ingestion), "query" for text being
// searched with (chat) -- Voyage's models are trained asymmetrically and
// expect this distinction for best retrieval quality.
export async function embed(input: string[], inputType: "document" | "query"): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    throw new Error(`Voyage AI request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return data.data.map((item: { embedding: number[] }) => item.embedding);
}
