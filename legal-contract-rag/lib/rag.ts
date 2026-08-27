import { InferenceClient } from "@huggingface/inference";
import { searchDocuments, type SearchResult } from "./search";

const client = new InferenceClient(process.env.HF_TOKEN);

const CHAT_MODEL = "meta-llama/Llama-3.1-8B-Instruct";

export interface RagAnswer {
  answer: string;
  sources: SearchResult[];
}

export async function askQuestion(question: string): Promise<RagAnswer> {
  const sources = await searchDocuments(question, 3);

  const context = sources
    .map(
      (source, index) =>
        `[${index + 1}] (${source.source} — ${source.section})\n${source.text}`,
    )
    .join("\n\n");

  const response = await client.chatCompletion({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a legal contract assistant. Answer the user's question using ONLY the provided contract excerpts. " +
          "Cite the excerpt numbers you used, e.g. [1]. " +
          "If the excerpts do not contain the answer, say you don't know. " +
          "Watch for amendments that override the original agreement.",
      },
      {
        role: "user",
        content: `Contract excerpts:\n\n${context}\n\nQuestion: ${question}`,
      },
    ],
    max_tokens: 500,
  });

  return {
    answer: response.choices[0].message.content ?? "",
    sources,
  };
}
