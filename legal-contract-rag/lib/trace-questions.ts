export const QUESTION_POOL: string[] = [
  "What happens if a match is abandoned before a ball is bowled?",
  "Can the franchise sign a second energy drink sponsor?",
  "How many overseas players can we field in a match?",
  "What is the penalty for going over the salary cap?",
  "Who pays for a player's treatment if he gets injured in training?",
  "What is Rohan Sharma's retainer?",
  "How much do we pay Dinesh Mendis for each match he plays?",
  "When does the sponsorship money actually arrive?",
  "Can a player appeal a Level 2 fine?",
  "How many demerit points does a Level 4 offence carry?",
  "What happens if a player misses three whereabouts filings?",
  "Is there a sell-on clause in the Arjun Kale transfer?",
  "How much does it cost to hire the stadium for the final?",
  "Who keeps the catering money at home games?",
  "What is the notice period to end the stadium agreement?",
  "How does Sharma's termination notice compare with Mendis's?",
  "How many cameras are needed to broadcast a match?",
  "Can Meridian Sports Network show matches in Australia?",
  "What is the annual franchise fee?",
  "Who decides how the pitch is prepared?",
  "If a player tests positive, how long before he is suspended?",
  "What is the deadline to apply for a therapeutic use exemption?",
  "Does the franchise own a player's image rights?",
  "Can Mendis keep his existing endorsement deals?",
  "What is the maximum squad size?",
  "What happens if fewer than 60 matches are played in a season?",
  "How much notice is needed to end the sponsorship agreement?",
  "Who is liable for Arjun Kale's match fees from before the transfer?",
  "What public liability insurance must the stadium carry?",
  "Is match fixing a Level 3 or a Level 4 offence?",
  "How long does the franchise agreement run for?",
  "What share of ticket revenue does the club keep?",
  "When must an overseas player obtain his no objection certificate?",
  "What is the vice captain's retainer?",
  "How much advertising time does the League keep in each broadcast?",
  "What happens to a player's contract if he commits a Level 4 offence?",
  "Can we stage a home game in Bangalore?",
  "What is the most we can spend on players in one season?",
  "How is central broadcast revenue distributed to the franchises?",
  "What is the hire charge for a play-off match?",
  "Who appoints the food vendors at the stadium?",
  "How is Rohan Sharma's retainer paid out across the year?",
  "Can a franchise be thrown out of the league?",
  "What is the ban for a first anti-doping offence?",
  "Does the sponsor get money back if a player misbehaves?",
];

/** Deterministic PRNG, so a sample can be reproduced exactly from its seed. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random sample without replacement. The seed is recorded with the traces so
 * the same batch can be pulled again — sampling is only fair if it is also
 * reproducible and not quietly re-rolled until it looks good.
 */
export function sampleQuestions(count: number, seed: number): string[] {
  const random = mulberry32(seed);
  const pool = [...QUESTION_POOL];

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, Math.min(count, pool.length));
}
