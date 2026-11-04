/**
 * Week 9: the clause-search MCP server — the app's one real capability,
 * exposed the standard way, so any MCP host can use it and not only our agent.
 *
 *   npx tsx mcp/clause-search/server.mts      speaks JSON-RPC on stdin/stdout
 *
 * These are the week 7 tools, moved out of the agent unchanged. Each is a plain
 * lookup with no model call inside: the host runs the model, and this process
 * only ever answers initialize, tools/list and tools/call.
 */
import "../../scripts/env.mts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// stdout is the protocol channel. One stray console.log from a library would
// corrupt the stream, so everything printed goes to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

// Imported after the environment is loaded: lib modules read it when they load.
const { searchDocuments } = await import("../../lib/search");
const { searchKeywords } = await import("../../lib/bm25");
const { findAmendments, findContract, listContracts, readSection, resolveDefinedTerm, sectionsOf } = await import(
  "../../lib/contracts"
);
const { formatClause } = await import("../../lib/tools");

type Chunk = Awaited<ReturnType<typeof sectionsOf>>[number];

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const failure = (text: string) => ({ ...reply(text), isError: true });

async function formatClauses(chunks: Chunk[]): Promise<string> {
  return (await Promise.all(chunks.map(formatClause))).join("\n\n");
}

async function unknownContract(id: string) {
  const ids = (await listContracts()).map((contract) => contract.id).join(", ");
  return failure(`No contract has id "${id}". Known ids: ${ids}. Use list_contracts to match a name to an id.`);
}

const server = new McpServer(
  { name: "clause-search", version: "1.0.0" },
  {
    instructions:
      "Read-only search over the franchise's contract store. Every clause comes back labelled [CONTRACT-ID §N]; cite those labels.",
  },
);

server.registerTool(
  "list_contracts",
  {
    title: "List contracts",
    description:
      "Lists every document in the store: id, title, and its first section (the parties, or what an amendment modifies). " +
      "Use it first when the question names a person, company, or venue instead of a contract id — clauses almost never repeat the names, so you need the id to scope a search.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const contracts = await listContracts();
    return reply(
      contracts
        .map((c) => `${c.id}${c.isAmendment ? " (amendment)" : ""} — ${c.title}\n  ${c.parties.slice(0, 220)}`)
        .join("\n"),
    );
  },
);

/**
 * Week 9, Set F: this description is written as a prompt — when to call the
 * tool, how to word the call, what the result does not include, and what to do
 * when it fails — because it is the only thing a model ever reads about it.
 */
server.registerTool(
  "search_clauses",
  {
    title: "Search clauses",
    description: [
      "Finds the clauses that deal with a topic when you do not know which section holds them. Returns the 3 best matches, each labelled [CONTRACT-ID §N]; cite those labels.",
      "Use it when you know what the clause is about (termination notice, injury, image rights) but not its number. If you already know the section, read_section is exact and cheaper.",
      "Word the query the way a contract does, not the way the user asked: \"notice period\", \"retainer\", \"Franchise Activity\".",
      "Pass contract_id whenever you know the contract. The two player contracts (PC-2026-011, PC-2026-027) are worded almost identically, and an unscoped search often returns the other player's clause. Leave it out only to find which document covers a topic.",
      "Clauses come back as executed: amendments are NOT applied. Before answering with a fee, date or notice period, check that contract's amendments.",
      "If the search index is down, the reply says so and falls back to keyword matching. That means an outage, not a missing clause, and repeating the call will not fix it. Follow what the reply suggests instead.",
    ].join("\n"),
    inputSchema: {
      query: z.string().describe('Words the clause itself would use, e.g. "termination notice period".'),
      contract_id: z
        .string()
        .optional()
        .describe("Id from the contract's header, e.g. PC-2026-027. Omit only to search every document."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, contract_id }) => {
    if (!query.trim()) return failure('search_clauses needs a "query".');

    let contract: Awaited<ReturnType<typeof findContract>>;
    if (contract_id?.trim()) {
      contract = await findContract(contract_id);
      if (!contract) return unknownContract(contract_id);
    }

    try {
      const results = await searchDocuments(query, 3, "hybrid", contract?.source);
      if (!results.length) return reply("No clauses matched.");
      return reply(await formatClauses(results));
    } catch (error) {
      return searchOutage(query, contract, error);
    }
  },
);

/**
 * The semantic half of the search lives in Qdrant. When it cannot be reached,
 * the old reply was the raw exception — "fetch failed" — which a model reads as
 * a bad query and retries, reworded, until it runs out of steps. This reply
 * names the outage, says what it does and does not mean, still returns the
 * keyword half of the search, and points at a tool that needs no index.
 */
async function searchOutage(
  query: string,
  contract: Awaited<ReturnType<typeof findContract>>,
  error: unknown,
) {
  const reason = (error as { cause?: { code?: string } })?.cause?.code ?? (error instanceof Error ? error.message : String(error));
  const scope = contract ? contract.id : "the store";

  const keyword = (await searchKeywords(query, 1000))
    .filter((result) => !contract || result.chunk.source === contract.source)
    .slice(0, 3)
    .map((result) => result.chunk);

  const sections = contract
    ? (await sectionsOf(contract.source)).map((chunk) => `§${chunk.section.replace(/^(\d+)\.\s*/, "$1 ")}`).join("; ")
    : "";
  const next = contract
    ? `read_section needs no index — ${contract.id}'s sections are: ${sections}.`
    : "list_contracts and read_section need no index.";

  const head =
    `The search index is unreachable (vector store: ${reason}). This is an outage on the search side, not a sign that ${scope} lacks such a clause, ` +
    "and repeating this call — reworded or not — will not help.";

  if (!keyword.length) {
    return failure(`${head} Keyword matching found nothing for "${query}" either. Next: ${next}`);
  }

  return reply(
    `${head}\nKeyword-only matches (they share your words; a clause worded differently can be missed):\n\n` +
      `${await formatClauses(keyword)}\n\nIf none of these answers the question: ${next}`,
  );
}

server.registerTool(
  "read_section",
  {
    title: "Read a section",
    description:
      "Returns the full text of one numbered section of one contract. " +
      'Use it when a clause refers to another section ("the term set out in Section 2") or you know exactly which section you need.',
    inputSchema: {
      contract_id: z.string(),
      section: z.coerce.number(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ contract_id, section }) => {
    const contract = await findContract(contract_id);
    if (!contract) return unknownContract(contract_id);

    const chunk = await readSection(contract_id, section);
    if (!chunk) {
      const available = (await sectionsOf(contract.source)).map((c) => c.section).join("; ");
      return failure(`${contract.id} has no section ${section}. Sections: ${available}`);
    }

    return reply(await formatClause(chunk));
  },
);

server.registerTool(
  "find_amendments",
  {
    title: "Find amendments",
    description:
      "Returns every amendment that modifies the given contract, with its full text. " +
      "Call it before answering with any fee, date, or notice period from a contract: an amendment may have replaced the value, and the amendment wins.",
    inputSchema: {
      contract_id: z.string(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ contract_id }) => {
    const contract = await findContract(contract_id);
    if (!contract) return unknownContract(contract_id);

    const amendments = await findAmendments(contract.id);
    if (!amendments.length) return reply(`No amendments modify ${contract.id}. Its own clauses are current.`);

    const clauses = (await Promise.all(amendments.map((a) => sectionsOf(a.source)))).flat();
    return reply(`${amendments.length} amendment(s) modify ${contract.id}:\n\n${await formatClauses(clauses)}`);
  },
);

server.registerTool(
  "resolve_defined_term",
  {
    title: "Resolve a defined term",
    description:
      'Returns what a contract defines a capitalised term to mean (e.g. "Season", "Match Fee", "Franchise Activity"), cited [CONTRACT-ID §N]. ' +
      "Call it whenever your answer turns on such a term, and use the definition, never the ordinary meaning of the word. " +
      "If it returns nothing, the documents do not define the term: say so, do not guess.",
    inputSchema: {
      term: z.string().describe('The term as capitalised in the contract, e.g. "Match Fee".'),
      contract_id: z.string().optional().describe("Scope to one contract. Omit to see every contract's definition — they can differ."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ term, contract_id }) => {
    if (contract_id?.trim() && !(await findContract(contract_id))) return unknownContract(contract_id);
    const found = await resolveDefinedTerm(term, contract_id);
    if (!found.length) {
      return reply(`No document defines "${term}". Do not assume its ordinary meaning; say the term is undefined in the store and refer the question to counsel.`);
    }
    return reply(found.map((d) => `[${d.contractId} §${d.section}] "${d.term}" means ${d.definition}`).join("\n"));
  },
);

// Week 12 — the privilege line. This server answers clients the host does not
// control, so personal contact details are masked on the way out. (The store
// has none today; the filter is the guard for the day it does.)
const MASKS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email redacted]"],
  [/\+\d[\d\s().-]{8,}\d|\b\d{10,}\b/g, "[number redacted]"],
];
export function redact(text: string): string {
  return process.env.MCP_REDACT === "off" ? text : MASKS.reduce((out, [pattern, label]) => out.replace(pattern, label), text);
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Week 12 — one audit line per tools/call, keyed by the caller's trace id (it
// arrives in the request's _meta). Only the tool name, contract scope, timing
// and size are logged: never the query text or what was returned.
const audit = path.join(process.cwd(), "logs", "mcp");
const pending = new Map<string | number, { at: number; line: Record<string, unknown> }>();
const received = transport.onmessage;
transport.onmessage = (message) => {
  const request = message as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } };
  if (request.method === "tools/call" && request.id !== undefined) {
    pending.set(request.id, {
      at: Date.now(),
      line: {
        ts: new Date().toISOString(),
        trace_id: request.params?._meta?.trace_id ?? null,
        parent_span_id: request.params?._meta?.parent_span_id ?? null,
        server: "clause-search",
        tool: request.params?.name,
        contract_id: request.params?.arguments?.contract_id ?? null,
      },
    });
  }
  received?.(message);
};
const sent = transport.send.bind(transport);
transport.send = async (message) => {
  const response = message as { id?: string | number; result?: { content?: { text?: string }[]; isError?: boolean } };
  const entry = response.id !== undefined ? pending.get(response.id) : undefined;
  if (entry && response.result) {
    pending.delete(response.id!);
    const content = response.result.content ?? [];
    for (const part of content) if (part.text) part.text = redact(part.text);
    mkdirSync(audit, { recursive: true });
    appendFileSync(
      path.join(audit, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify({ ...entry.line, duration_ms: Date.now() - entry.at, bytes: content.reduce((n, p) => n + (p.text?.length ?? 0), 0), is_error: Boolean(response.result.isError) })}\n`,
    );
  }
  return sent(message);
};
