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

// stdout is the protocol channel. One stray console.log from a library would
// corrupt the stream, so everything printed goes to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

// Imported after the environment is loaded: lib modules read it when they load.
const { searchDocuments } = await import("../../lib/search");
const { findAmendments, findContract, listContracts, readSection, sectionsOf } = await import(
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

server.registerTool(
  "search_clauses",
  {
    title: "Search clauses",
    description:
      "Hybrid keyword + semantic search over clauses; returns the top 3, each labelled [CONTRACT-ID §N]. " +
      "Pass contract_id whenever you know which contract the question is about — the two player contracts share almost identical wording, and an unscoped search often returns the other player's clause. " +
      "Leave contract_id out only to discover which document covers a topic.",
    inputSchema: {
      query: z.string(),
      contract_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, contract_id }) => {
    if (!query.trim()) return failure('search_clauses needs a "query".');

    let source: string | undefined;
    if (contract_id?.trim()) {
      const contract = await findContract(contract_id);
      if (!contract) return unknownContract(contract_id);
      source = contract.source;
    }

    const results = await searchDocuments(query, 3, "hybrid", source);
    if (!results.length) return reply("No clauses matched.");

    return reply(await formatClauses(results));
  },
);

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

await server.connect(new StdioServerTransport());
