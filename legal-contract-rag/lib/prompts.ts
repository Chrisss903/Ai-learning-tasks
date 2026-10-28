import { createHash } from "node:crypto";
import type { Chunk } from "./chunking";
import { findAmendments, listContracts, resolveContracts, sectionNumber, sectionsOf } from "./contracts";
import type { ChatMessage } from "./generator";
import { searchDocuments, type SearchMode, type SearchResult } from "./search";
import { span } from "./telemetry";
import { clauseLabel } from "./tools";

/**
 * Week 11: the answer prompt, versioned.
 *
 * A version pins everything that decides what the model reads: the system
 * prompt, which clauses become excerpts, and how each excerpt is labelled.
 * Every request logs the version it ran, so a complaint can be sliced by it,
 * and rolling a change back is one environment variable, not a revert.
 */
export interface Excerpt extends SearchResult {
  /** "PC-2026-011 §8" */
  label: string;
  via: "search" | "amendment";
  /** For an attached amendment: the chunk id of the clause it replaces. */
  amends?: number;
}

export interface PromptVersion {
  id: string;
  /** What changed in this version, and why. */
  change: string;
  /** The clauses the model will read, in the order it reads them — [n] is index n-1. */
  context(question: string, mode: SearchMode): Promise<Excerpt[]>;
  /** The excerpts as the model sees them. Also what the judge is shown. */
  render(excerpts: Excerpt[]): Promise<string>;
  messages(question: string, rendered: string): ChatMessage[];
}

async function labelled(results: SearchResult[], via: Excerpt["via"]): Promise<Excerpt[]> {
  return Promise.all(results.map(async (result) => ({ ...result, label: await clauseLabel(result), via })));
}

/** Weeks 3–10, unchanged: top-3 search, excerpts headed by file name. */
const V1: PromptVersion = {
  id: "rag-answer@1",
  change: "The prompt as it shipped in weeks 3–10.",

  context: (question, mode) =>
    span("retrieval.search", "retrieval", async (handle) => {
      handle.set({ mode, top_k: 3 });
      return labelled(await searchDocuments(question, 3, mode), "search");
    }),

  render: async (excerpts) =>
    excerpts
      .map((source, index) => `[${index + 1}] (${source.source} — ${source.section})\n${source.text}`)
      .join("\n\n"),

  messages: (question, rendered) => [
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
      content: `Contract excerpts:\n\n${rendered}\n\nQuestion: ${question}`,
    },
  ],
};

/** "Section 8 of PC-2026-011 is amended" → 8. Matches how both amendments in the corpus word it. */
const AMENDS_SECTION = /\bSection\s+(\d+)\s+of\b[^.]*?\bamended\b/i;

const asResult = (chunk: Chunk): SearchResult => ({ ...chunk, score: 0, vectorRank: null, keywordRank: null });

/** The clauses of other documents that amend this clause's section, if any. */
async function amendingClauses(clause: SearchResult): Promise<Chunk[]> {
  const contract = (await listContracts()).find((c) => c.source === clause.source);
  const section = sectionNumber(clause.section);
  if (!contract || contract.isAmendment || section === null) return [];

  const amendments = await findAmendments(contract.id);
  const clauses = (await Promise.all(amendments.map((amendment) => sectionsOf(amendment.source)))).flat();
  return clauses.filter((chunk) => Number(chunk.text.match(AMENDS_SECTION)?.[1]) === section);
}

/**
 * Week 11 fix, from the support drill. Asked "How much notice does Rohan
 * Sharma need to give to terminate his contract?", rag-answer@1 was shown
 * PC-2026-011 §8 (60 days, superseded), Mendis's PC-2026-027 §8, and never the
 * amendment that made it 90 days — and cited the superseded clause. Each cause
 * gets one change:
 *
 *   1. search is scoped to the contract the question names     (wrong contract fetched)
 *   2. a clause an amendment replaced brings the amendment    (amendment never fetched)
 *   3. every excerpt says which contract it binds, and a legend
 *      says who each contract is between                       (sibling clauses indistinguishable)
 *   4. the prompt says an amendment's value is the one in force,
 *      and another contract's clause is never the answer
 *
 * 1 and 2 are the week 7 workflow's lookups (resolveContracts, findAmendments
 * — the same functions the agent's MCP tools call), so they are logged as tools.
 *
 * rag-answer@2 and @3 differ only in how an amendment is described; see @3.
 */
interface AmendmentWording {
  /** Note on a clause that an attached amendment changes. */
  amendedBy: (n: number) => string;
  /** Note on the attached amendment itself. */
  amends: (label: string, n: number) => string;
  /** The prompt's rule for reading the two together. */
  rule: string;
}

function contractAware(id: string, change: string, wording: AmendmentWording): PromptVersion {
  return {
    id,
    change,

    async context(question, mode) {
      const named = await span("tools.resolve_contracts", "tools", async (handle) => {
        const contracts = await resolveContracts(question);
        handle.set({ found: contracts.map((contract) => contract.id).join(", ") || "none" });
        return contracts;
      });

      const searched = await span("retrieval.search", "retrieval", async (handle) => {
        handle.set({ mode, top_k: 3, scope: named.map((contract) => contract.id).join(", ") || "all" });
        const lists = named.length
          ? await Promise.all(named.map((contract) => searchDocuments(question, 3, "hybrid", contract.source)))
          : [await searchDocuments(question, 3, mode)];
        return [...new Map(lists.flat().map((result) => [result.id, result])).values()];
      });

      return span("tools.find_amendments", "tools", async (handle) => {
        const excerpts: Excerpt[] = [];
        const seen = new Set(searched.map((result) => result.id));

        for (const clause of searched) {
          excerpts.push(...(await labelled([clause], "search")));
          // Right after the clause it replaces, so the two are read together.
          const amending = (await amendingClauses(clause)).filter((chunk) => !seen.has(chunk.id));
          amending.forEach((chunk) => seen.add(chunk.id));
          for (const excerpt of await labelled(amending.map(asResult), "amendment")) {
            excerpts.push({ ...excerpt, amends: clause.id });
          }
        }

        handle.set({ found: excerpts.filter((excerpt) => excerpt.via === "amendment").map((e) => e.label).join(", ") || "none" });
        return excerpts;
      });
    },

    async render(excerpts) {
      const catalog = await listContracts();
      const contractOf = (excerpt: Excerpt) => catalog.find((contract) => contract.source === excerpt.source);
      const name = (label: string) => label.replace(/ §\?$/, " (header)");

      const involved = [...new Set(excerpts.map(contractOf).filter((contract) => contract !== undefined))];
      const legend = involved.map((contract) => `- ${contract.id} (${contract.title}): ${contract.parties}`).join("\n");

      const numberOf = new Map(excerpts.map((excerpt, index) => [excerpt.id, index + 1]));
      const byId = new Map(excerpts.map((excerpt) => [excerpt.id, excerpt]));
      const replacedBy = new Map(excerpts.filter((e) => e.amends).map((e) => [e.amends!, numberOf.get(e.id)]));

      const body = excerpts.map((excerpt, index) => {
        const replaced = excerpt.amends ? byId.get(excerpt.amends) : undefined;
        const note = replaced
          ? wording.amends(name(replaced.label), numberOf.get(replaced.id)!)
          : replacedBy.has(excerpt.id)
            ? wording.amendedBy(replacedBy.get(excerpt.id)!)
            : "";
        return `[${index + 1}] ${name(excerpt.label)} — ${excerpt.section}${note}\n${excerpt.text}`;
      });

      return `Contracts these excerpts come from:\n${legend}\n\nExcerpts:\n\n${body.join("\n\n")}`;
    },

    messages: (question, rendered) => [
      {
        role: "system",
        content:
          "You are a legal contract assistant. Answer the user's question using ONLY the provided contract excerpts. " +
          "Each excerpt is labelled with the contract it comes from; the list at the top says who each contract is between. " +
          "Answer from the excerpts of the contract the question asks about. A clause from a different contract is never the answer, " +
          "even when it is the same kind of clause — if that contract's clause is not among the excerpts, say you don't know. " +
          wording.rule +
          "Cite the excerpt numbers you used, e.g. [1]. " +
          "If the excerpts do not contain the answer, say you don't know.",
      },
      {
        role: "user",
        content: `${rendered}\n\nQuestion: ${question}`,
      },
    ],
  };
}

/** Rejected by the suite, never shipped: kept because eval traces record it. */
const V2 = contractAware(
  "rag-answer@2",
  "Contract-aware context: search scoped to the contract named, amending clauses attached, excerpts labelled by contract.",
  {
    amendedBy: (n) => ` — replaced by [${n}]`,
    amends: (label, n) => ` — AMENDS ${label} [${n}]; this is the value in force`,
    rule:
      "An excerpt marked AMENDS replaces the section it names, so its value is the one in force: state it, cite the amendment, " +
      "and mention the original only as replaced. ",
  },
);

/**
 * @2 said an amended clause was "replaced". An amendment changes one value in
 * a section — AMD-PC-011-01 §2 changes the retainer amount, and the
 * instalment schedule in the same §4 still stands — so @2 failed T06: the
 * judge, reading "replaced by [2]", called a correct answer unsupported. A
 * model reading it could drop a term that is still in force just as easily.
 */
const V3 = contractAware(
  "rag-answer@3",
  "As rag-answer@2, but an amendment is described as changing a section, not replacing it.",
  {
    amendedBy: (n) => ` — amended by [${n}]`,
    amends: (label, n) => ` — AMENDS ${label} [${n}]: where the two differ, this one is in force`,
    rule:
      "An excerpt marked AMENDS changes the section it names: where the two differ, the amendment is in force — state its value, " +
      "cite the amendment, and mention the original only as replaced. Whatever the amendment does not change still stands. ",
  },
);

export const PROMPT_VERSIONS: Record<string, PromptVersion> = {
  [V1.id]: V1,
  [V2.id]: V2,
  [V3.id]: V3,
};

/**
 * What production serves when nothing overrides it. Bumped from rag-answer@1
 * to @3 on 2026-10-28 after the week 11 drill (@2 regressed T06 and never
 * shipped). Roll back with PROMPT_VERSION=rag-answer@1.
 */
export const DEFAULT_PROMPT_VERSION = "rag-answer@3";

export function getPrompt(id: string): PromptVersion {
  const prompt = PROMPT_VERSIONS[id];
  if (!prompt) {
    throw new Error(`Unknown prompt version "${id}". Known: ${Object.keys(PROMPT_VERSIONS).join(", ")}`);
  }
  return prompt;
}

/** A user's stable place in 0–99, so a canary keeps the same people on it. */
function bucket(userId: string): number {
  return createHash("sha256").update(userId).digest().readUInt32BE(0) % 100;
}

/**
 * Which version a user gets.
 *
 *   PROMPT_VERSION=rag-answer@1            everyone on that version (the rollback)
 *   PROMPT_CANARY=rag-answer@3:10          10% of users, by user id, on the canary
 */
export function promptVersionFor(userId: string): string {
  const base = process.env.PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION;
  const [canary, percent] = (process.env.PROMPT_CANARY ?? "").split(":");

  if (canary && PROMPT_VERSIONS[canary] && bucket(userId) < Number(percent ?? 0)) return canary;
  return base;
}
