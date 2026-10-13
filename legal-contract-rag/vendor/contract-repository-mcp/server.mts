/**
 * contract-repository — MCP server over the executed-contract repository.
 * Owner: knowledge team. Read-only. Transport: stdio.
 *
 * STAND-IN: the knowledge team's real server is not available to this
 * exercise, so this file reproduces its published interface — lookup by
 * contract id, effective date, amendment chain — over the same repository
 * directory. It shares no code with the app on purpose: it is third-party.
 *
 * Environment
 *   CONTRACT_REPO_DIR    directory of executed contracts, one .txt per document (required)
 *   CONTRACT_REPO_TOKEN  repository service token (required; one token, reads every document)
 *   CONTRACT_REPO_LOG    access log (default logs/contract-repository.log)
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const REPO_DIR = process.env.CONTRACT_REPO_DIR;
const TOKEN = process.env.CONTRACT_REPO_TOKEN;
const LOG_FILE = process.env.CONTRACT_REPO_LOG ?? "logs/contract-repository.log";

if (!REPO_DIR || !TOKEN) {
  console.error("contract-repository: CONTRACT_REPO_DIR and CONTRACT_REPO_TOKEN must both be set");
  process.exit(1);
}

mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const log = (line: string) => appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);

// ---------------------------------------------------------------- repository

interface Section {
  number: number;
  heading: string;
  text: string;
}

interface Record {
  id: string;
  title: string;
  kind: "contract" | "amendment" | "policy";
  sections: Section[];
  /** ISO date, when the document states one. */
  effective: string | null;
  /** Where the effective date (or, failing that, the term) is stated. */
  effectiveSource: Section | null;
  /** For an amendment: the document it modifies and the sections it replaces. */
  amends: string | null;
  amendsSections: number[];
}

const ID_PATTERN = /\b[A-Z]{2,4}(?:-[A-Z]{2})?-\d{3,4}(?:-\d{2,3})*\b/g;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function isoDate(year: number, monthName: string, day: number): string | null {
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month === -1) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "October 1, 2026" or "1 January 2026", following "effective on" / "takes effect on". */
function statedEffectiveDate(text: string): string | null {
  const after = flat(text).match(/(?:becomes effective on|takes effect on|effective from)\s+(.{0,40})/i)?.[1];
  if (!after) return null;

  const us = after.match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
  if (us) return isoDate(Number(us[3]), us[1], Number(us[2]));

  const uk = after.match(/^(\d{1,2}) ([A-Z][a-z]+) (\d{4})/);
  if (uk) return isoDate(Number(uk[3]), uk[2], Number(uk[1]));

  return null;
}

function parse(text: string): Record | null {
  const id = text.match(/^(Contract|Agreement|Amendment|Document) ID:\s*(\S+)/m);
  if (!id) return null;

  const sections = text
    .split(/\n\s*\n(?=\d+\.\s)/)
    .slice(1)
    .map((part) => {
      const match = part.trim().split("\n")[0].match(/^(\d+)\.\s+(.*)$/);
      return match ? { number: Number(match[1]), heading: match[2].trim(), text: part.trim() } : null;
    })
    .filter((section): section is Section => section !== null);

  const kind = id[1] === "Amendment" ? "amendment" : id[1] === "Document" ? "policy" : "contract";

  const dated = sections.find((section) => statedEffectiveDate(section.text));
  const term = sections.find((section) => /\bTERM\b|HIRE PERIOD/.test(section.heading));

  const purpose = flat(sections.find((section) => section.number === 1)?.text ?? "");
  const amends =
    kind === "amendment" ? ([...purpose.matchAll(ID_PATTERN)].map((m) => m[0]).find((m) => m !== id[2]) ?? null) : null;

  const amendsSections =
    kind === "amendment"
      ? [...flat(text).matchAll(/Section (\d+) of (?:the original [A-Za-z ]+?|[A-Z0-9-]+) (?:is hereby|is) amended/g)].map(
          (m) => Number(m[1]),
        )
      : [];

  return {
    id: id[2],
    title: text.split("\n")[0].trim(),
    kind,
    sections,
    effective: dated ? statedEffectiveDate(dated.text) : null,
    effectiveSource: dated ?? term ?? null,
    amends,
    amendsSections,
  };
}

const repository: Record[] = readdirSync(REPO_DIR)
  .filter((file) => file.endsWith(".txt"))
  .sort()
  .map((file) => parse(readFileSync(path.join(REPO_DIR, file), "utf-8")))
  .filter((record): record is Record => record !== null);

const byId = (id: string) => repository.find((record) => record.id.toUpperCase() === id.trim().toUpperCase());

/** Amendments of a contract, oldest first; undated ones last. */
const chainOf = (id: string) =>
  repository
    .filter((record) => record.amends?.toUpperCase() === id.toUpperCase())
    .sort((a, b) => (a.effective ?? "9999").localeCompare(b.effective ?? "9999"));

const label = (record: Record, section: Section) => `[${record.id} §${section.number}] ${section.text}`;
const headingOf = (record: Record | undefined, number: number) =>
  record?.sections.find((section) => section.number === number)?.heading ?? "?";

// ------------------------------------------------------------------- replies

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const failure = (text: string) => ({ ...reply(text), isError: true });

function closestIds(id: string): string {
  const wanted = id.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const scored = repository
    .map((record) => {
      const candidate = record.id.toUpperCase().replace(/[^A-Z0-9]/g, "");
      let shared = 0;
      while (shared < Math.min(wanted.length, candidate.length) && wanted[shared] === candidate[shared]) shared++;
      return { id: record.id, shared };
    })
    .sort((a, b) => b.shared - a.shared);
  return scored.slice(0, 3).map((s) => s.id).join(", ");
}

function notFound(id: string) {
  return failure(
    `No document with id "${id}" in the repository. This is a lookup miss, not an outage. ` +
      `Closest ids: ${closestIds(id)}. All ids: ${repository.map((r) => r.id).join(", ")}.`,
  );
}

function audited<A extends object>(tool: string, handler: (args: A) => ReturnType<typeof reply> | ReturnType<typeof failure>) {
  return async (args: A) => {
    const started = Date.now();
    const result = handler(args);
    log(`tools/call ${tool} ${JSON.stringify(args)} ${"isError" in result ? "error" : "ok"} ${Date.now() - started}ms`);
    return result;
  };
}

// --------------------------------------------------------------------- tools

const server = new McpServer(
  { name: "contract-repository", version: "2.3.0" },
  {
    instructions:
      "Knowledge team contract repository. Read-only lookups of executed documents by id: the record itself, its effective date, and its amendment chain.",
  },
);

server.registerTool(
  "get_contract",
  {
    title: "Get contract by id",
    description:
      "Looks up one executed document by its id and returns its record: title, kind, effective date, the amendments recorded against it, and its full text as executed. " +
      "The text is the original — amendments are listed but NOT applied; use get_amendment_chain for what changed.",
    inputSchema: { contract_id: z.string().describe("Document id as printed in its header, e.g. SA-2026-001.") },
    annotations: { readOnlyHint: true },
  },
  audited("get_contract", ({ contract_id }: { contract_id: string }) => {
    const record = byId(contract_id);
    if (!record) return notFound(contract_id);

    const chain = chainOf(record.id);
    const lines = [
      `${record.id} — ${record.title} (${record.kind}${record.amends ? ` of ${record.amends}` : ""})`,
      `Effective: ${record.effective ?? "no calendar date stated in the document"}`,
      `Amended by: ${chain.length ? chain.map((a) => `${a.id} (effective ${a.effective ?? "undated"}; amends §${a.amendsSections.join(", §")})`).join("; ") : "nothing recorded"}`,
      "",
      "Text as executed:",
      ...record.sections.map((section) => label(record, section)),
    ];
    return reply(lines.join("\n"));
  }),
);

server.registerTool(
  "get_effective_date",
  {
    title: "Get effective date",
    description:
      "Returns the date a document took effect, quoting the clause that says so, plus the dates its amendments took effect. " +
      "When a document states no calendar date, says so and quotes its term clause instead.",
    inputSchema: { contract_id: z.string().describe("Document id, e.g. AMD-2026-001 or SA-2026-001.") },
    annotations: { readOnlyHint: true },
  },
  audited("get_effective_date", ({ contract_id }: { contract_id: string }) => {
    const record = byId(contract_id);
    if (!record) return notFound(contract_id);

    const source = record.effectiveSource;
    const quoted = source ? `${label(record, source)}` : "(no date or term clause found)";
    const head = record.effective
      ? `${record.id} took effect on ${record.effective}. Stated in:`
      : `${record.id} states no calendar effective date. Closest clause:`;

    const chain = chainOf(record.id);
    const amendments = chain.length
      ? `\nAmendments: ${chain.map((a) => `${a.id} took effect on ${a.effective ?? "an undated day"}`).join("; ")}.`
      : "";

    return reply(`${head}\n${quoted}${amendments}`);
  }),
);

server.registerTool(
  "get_amendment_chain",
  {
    title: "Get amendment chain",
    description:
      "Returns every amendment recorded against a contract, oldest first, with each one's effective date, the sections it replaces, and its text. " +
      "Pass as_of (YYYY-MM-DD) to see which amendments were in force on that date.",
    inputSchema: {
      contract_id: z.string().describe("Id of the original contract, not of an amendment."),
      as_of: z.string().optional().describe("Date to evaluate the chain on, YYYY-MM-DD. Defaults to today."),
    },
    annotations: { readOnlyHint: true },
  },
  audited("get_amendment_chain", ({ contract_id, as_of }: { contract_id: string; as_of?: string }) => {
    const record = byId(contract_id);
    if (!record) return notFound(contract_id);

    if (record.kind === "amendment") {
      return failure(
        `${record.id} is itself an amendment (of ${record.amends ?? "an unknown contract"}). ` +
          `Call get_amendment_chain with ${record.amends ?? "the original contract's id"}.`,
      );
    }

    const date = as_of?.trim() || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return failure(`as_of must be a calendar date written YYYY-MM-DD (e.g. 2026-10-15); got "${as_of}".`);
    }

    if (record.effective && date < record.effective) {
      return failure(
        `${record.id} was not yet in effect on ${date}: it took effect on ${record.effective}. ` +
          `There is no contract, amended or not, to evaluate on that date. Check the date, or omit as_of for today.`,
      );
    }

    const chain = chainOf(record.id);
    if (!chain.length) {
      return reply(`No amendments are recorded against ${record.id}. Its text as executed is current on ${date}.`);
    }

    const lines = [`Amendment chain for ${record.id} (${record.effective ? `effective ${record.effective}` : "no calendar effective date stated"}), oldest first, evaluated on ${date}:`];
    chain.forEach((amendment, index) => {
      const inForce = amendment.effective ? amendment.effective <= date : true;
      lines.push(
        "",
        `${index + 1}. ${amendment.id} — effective ${amendment.effective ?? "undated"} — replaces ${amendment.amendsSections.map((n) => `§${n} ${headingOf(record, n)}`).join(", ")} — ${inForce ? `IN FORCE on ${date}` : `NOT YET in force on ${date}; until ${amendment.effective} those sections read as executed`}`,
        ...amendment.sections.map((section) => label(amendment, section)),
      );
    });
    return reply(lines.join("\n"));
  }),
);

log(`started repo=${REPO_DIR} documents=${repository.length}`);
await server.connect(new StdioServerTransport());
