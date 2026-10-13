import type { Chunk } from "./chunking";
import { listContracts, sectionNumber } from "./contracts";

/**
 * How a clause is shown and cited.
 *
 * Week 9: the agent's tools used to live here, wired in by hand. They moved to
 * the clause-search MCP server (mcp/clause-search/server.mts) and the agent
 * now discovers them; what stays is the labelling, which the server and the
 * fixed workflow share so a citation means the same thing in both.
 */

/** "PC-2026-011 §4" — how a clause is cited, and how a citation is checked. */
export async function clauseLabel(chunk: Chunk): Promise<string> {
  const contract = (await listContracts()).find((c) => c.source === chunk.source);
  return `${contract?.id ?? chunk.source} §${sectionNumber(chunk.section) ?? "?"}`;
}

/** Every clause is labelled with its contract id, because clauses rarely name one. */
export async function formatClause(chunk: Chunk): Promise<string> {
  return `[${await clauseLabel(chunk)}] ${chunk.text}`;
}
