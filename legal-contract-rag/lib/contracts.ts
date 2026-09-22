import { loadChunks, type Chunk } from "./chunking";

/**
 * A catalog of the documents themselves, read straight from the chunks — no
 * model involved. Both the week 7 agent (through its tools) and the fixed
 * workflow use it, so any difference between them is the control flow, not the
 * lookups.
 */
export interface Contract {
  /** The id printed in the header, e.g. "PC-2026-011". */
  id: string;
  title: string;
  source: string;
  /** Section 1, which names the parties or says what an amendment modifies. */
  parties: string;
  isAmendment: boolean;
}

const ID_LINE = /^(?:Contract|Agreement|Amendment|Document) ID:\s*(\S+)/m;

/** Matches ids as they are written in the documents and in questions. */
export const CONTRACT_ID_PATTERN = /\b[A-Z]{2,4}(?:-[A-Z]{2})?-\d{3,4}(?:-\d{2,3})*\b/g;

export function sectionNumber(section: string): number | null {
  const match = section.match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

let cached: Contract[] | null = null;

export async function listContracts(): Promise<Contract[]> {
  if (cached) return cached;

  const bySource = new Map<string, Chunk[]>();
  for (const chunk of await loadChunks()) {
    bySource.set(chunk.source, [...(bySource.get(chunk.source) ?? []), chunk]);
  }

  cached = [...bySource.entries()].map(([source, chunks]) => {
    // The header chunk is the one before section 1.
    const header = chunks.find((chunk) => sectionNumber(chunk.section) === null)?.text ?? "";
    const first = chunks.find((chunk) => sectionNumber(chunk.section) === 1);

    return {
      id: header.match(ID_LINE)?.[1] ?? source,
      title: header.split("\n")[0].trim(),
      source,
      parties: (first?.text ?? "").split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim(),
      isAmendment: /^Amendment ID:/m.test(header),
    };
  });

  return cached;
}

export async function findContract(id: string): Promise<Contract | undefined> {
  const wanted = id.trim().toUpperCase();
  return (await listContracts()).find((contract) => contract.id.toUpperCase() === wanted);
}

export async function sectionsOf(source: string): Promise<Chunk[]> {
  return (await loadChunks()).filter(
    (chunk) => chunk.source === source && sectionNumber(chunk.section) !== null,
  );
}

export async function readSection(
  contractId: string,
  section: number,
): Promise<Chunk | undefined> {
  const contract = await findContract(contractId);
  if (!contract) return undefined;

  return (await sectionsOf(contract.source)).find(
    (chunk) => sectionNumber(chunk.section) === section,
  );
}

/** Amendments are the documents whose purpose clause names this contract's id. */
export async function findAmendments(contractId: string): Promise<Contract[]> {
  const wanted = contractId.trim().toUpperCase();

  return (await listContracts()).filter(
    (contract) =>
      contract.isAmendment &&
      contract.id.toUpperCase() !== wanted &&
      contract.parties.toUpperCase().includes(wanted),
  );
}

const GENERIC_NAME_WORDS = new Set([
  "agreement", "contract", "sample", "this", "player", "franchise", "venue",
  "sponsor", "league", "premier", "cricket", "club", "code", "policy", "terms",
]);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(
    (word) => !GENERIC_NAME_WORDS.has(word),
  );
}

/** Capitalised words in a parties clause: "Dinesh", "Mendis", "AlphaTech". */
function properNames(text: string): string[] {
  return words((text.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? []).join(" "));
}

/**
 * Deterministic contract resolution for the fixed workflow: explicit ids
 * first; otherwise words that point at a contract. A title word ("stadium",
 * "transfer") must belong to one contract only. A proper name may belong to
 * two — "AlphaTech" names both halves of the service arrangement — but a name
 * on every contract ("Chennai") identifies nothing and is ignored.
 */
export async function resolveContracts(question: string): Promise<Contract[]> {
  const contracts = (await listContracts()).filter((contract) => !contract.isAmendment);

  const ids = [...question.matchAll(CONTRACT_ID_PATTERN)].map((match) => match[0]);
  if (ids.length) {
    const byId = contracts.filter((contract) => ids.includes(contract.id));
    if (byId.length) return byId;
  }

  const titleOwners = new Map<string, Set<string>>();
  const nameOwners = new Map<string, Set<string>>();
  const own = (map: Map<string, Set<string>>, word: string, id: string) =>
    map.set(word, (map.get(word) ?? new Set()).add(id));

  for (const contract of contracts) {
    for (const word of words(contract.title)) own(titleOwners, word, contract.id);
    for (const word of properNames(contract.parties)) own(nameOwners, word, contract.id);
  }

  const matched = new Set<string>();
  for (const word of words(question)) {
    const byTitle = titleOwners.get(word);
    const byName = nameOwners.get(word);
    if (byTitle?.size === 1) matched.add([...byTitle][0]);
    if (byName && byName.size <= 2) byName.forEach((id) => matched.add(id));
  }

  return contracts.filter((contract) => matched.has(contract.id));
}
