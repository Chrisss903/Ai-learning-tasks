import { searchDocuments, type SearchMode, type SearchResult } from "./search";
import { resolveGenerator } from "./generator";

export interface RagAnswer {
  answer: string;
  sources: SearchResult[];
  mode: SearchMode;
  generator: string;
}

/**
 * Split out from askQuestion so the evaluator can reuse one retrieval pass for
 * both the retrieval metrics and the answer it grades.
 */
export async function generateAnswer(
  question: string,
  sources: SearchResult[],
): Promise<string> {
  const context = sources
    .map(
      (source, index) =>
        `[${index + 1}] (${source.source} — ${source.section})\n${source.text}`,
    )
    .join("\n\n");

  return resolveGenerator().complete([
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
  ]);
}

export async function askQuestion(
  question: string,
  mode: SearchMode = "vector",
): Promise<RagAnswer> {
  const sources = await searchDocuments(question, 3, mode);
  const answer = await generateAnswer(question, sources);

  return { answer, sources, mode, generator: resolveGenerator().label };
}
