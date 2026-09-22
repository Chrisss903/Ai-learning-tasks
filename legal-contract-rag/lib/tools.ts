import type { Chunk } from "./chunking";
import { searchDocuments } from "./search";
import {
  findAmendments,
  findContract,
  listContracts,
  readSection,
  sectionNumber,
  sectionsOf,
} from "./contracts";

/**
 * The agent's tools. Each is a plain function — no model call inside — that
 * returns text for the agent to read. The descriptions are the only thing the
 * model knows about a tool, so each says when to use it, not just what it does.
 */
export interface ToolResult {
  observation: string;
  /** Clauses the observation showed, so a final answer can be traced to them. */
  clauses: Chunk[];
}

export interface Tool {
  name: string;
  description: string;
  /** Shown to the model as the input shape. */
  input: string;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

/** Every clause is labelled with its contract id, because clauses rarely name one. */
export async function formatClause(chunk: Chunk): Promise<string> {
  const contract = (await listContracts()).find((c) => c.source === chunk.source);
  const label = `${contract?.id ?? chunk.source} §${sectionNumber(chunk.section) ?? "?"}`;
  return `[${label}] ${chunk.text}`;
}

async function formatClauses(chunks: Chunk[]): Promise<string> {
  return (await Promise.all(chunks.map(formatClause))).join("\n\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

async function unknownContract(id: string): Promise<ToolResult> {
  const ids = (await listContracts()).map((contract) => contract.id).join(", ");
  return {
    observation: `No contract has id "${id}". Known ids: ${ids}. Use list_contracts to match a name to an id.`,
    clauses: [],
  };
}

export const TOOLS: Tool[] = [
  {
    name: "list_contracts",
    description:
      "Lists every document in the store: id, title, and its first section (the parties, or what an amendment modifies). " +
      "Use it first when the question names a person, company, or venue instead of a contract id — clauses almost never repeat the names, so you need the id to scope a search.",
    input: "{}",
    async execute() {
      const contracts = await listContracts();
      return {
        observation: contracts
          .map(
            (c) =>
              `${c.id}${c.isAmendment ? " (amendment)" : ""} — ${c.title}\n  ${c.parties.slice(0, 220)}`,
          )
          .join("\n"),
        clauses: [],
      };
    },
  },
  {
    name: "search_clauses",
    description:
      "Hybrid keyword + semantic search over clauses; returns the top 3, each labelled [CONTRACT-ID §N]. " +
      "Pass contract_id whenever you know which contract the question is about — the two player contracts share almost identical wording, and an unscoped search often returns the other player's clause. " +
      "Leave contract_id out only to discover which document covers a topic.",
    input: '{"query": string, "contract_id"?: string}',
    async execute(input) {
      const query = text(input.query);
      if (!query) return { observation: 'search_clauses needs a "query".', clauses: [] };

      const contractId = text(input.contract_id);
      let source: string | undefined;
      if (contractId) {
        const contract = await findContract(contractId);
        if (!contract) return unknownContract(contractId);
        source = contract.source;
      }

      const results = await searchDocuments(query, 3, "hybrid", source);
      if (!results.length) return { observation: "No clauses matched.", clauses: [] };

      return { observation: await formatClauses(results), clauses: results };
    },
  },
  {
    name: "read_section",
    description:
      "Returns the full text of one numbered section of one contract. " +
      "Use it when a clause refers to another section (\"the term set out in Section 2\") or you know exactly which section you need.",
    input: '{"contract_id": string, "section": number}',
    async execute(input) {
      const contractId = text(input.contract_id);
      const section = Number(input.section);

      const contract = await findContract(contractId);
      if (!contract) return unknownContract(contractId);

      const chunk = await readSection(contractId, section);
      if (!chunk) {
        const available = (await sectionsOf(contract.source)).map((c) => c.section).join("; ");
        return {
          observation: `${contract.id} has no section ${input.section}. Sections: ${available}`,
          clauses: [],
        };
      }

      return { observation: await formatClause(chunk), clauses: [chunk] };
    },
  },
  {
    name: "find_amendments",
    description:
      "Returns every amendment that modifies the given contract, with its full text. " +
      "Call it before answering with any fee, date, or notice period from a contract: an amendment may have replaced the value, and the amendment wins.",
    input: '{"contract_id": string}',
    async execute(input) {
      const contractId = text(input.contract_id);
      const contract = await findContract(contractId);
      if (!contract) return unknownContract(contractId);

      const amendments = await findAmendments(contract.id);
      if (!amendments.length) {
        return { observation: `No amendments modify ${contract.id}. Its own clauses are current.`, clauses: [] };
      }

      const clauses = (await Promise.all(amendments.map((a) => sectionsOf(a.source)))).flat();
      return {
        observation: `${amendments.length} amendment(s) modify ${contract.id}:\n\n${await formatClauses(clauses)}`,
        clauses,
      };
    },
  },
];

/** Not a real tool — the action that ends the loop. Described alongside the others. */
export const FINISH = {
  name: "finish",
  description:
    "Ends the task with your final answer. Cite every clause you relied on as [CONTRACT-ID §N]. " +
    "If the documents do not contain the answer, say \"I don't know\" and what is missing — never borrow a clause from a different contract.",
  input: '{"answer": string}',
};
