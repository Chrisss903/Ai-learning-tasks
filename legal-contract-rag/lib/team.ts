import type { InputType } from "./input-type";

/**
 * Week 11: the people who use the app, for the traffic replay and the drill.
 * A complaint says "a lawyer", never a user id, so the role is logged too.
 */
export interface TeamMember {
  id: string;
  role: "lawyer" | "paralegal" | "team-manager" | "finance" | "commercial" | "analyst";
  /** Questions per weekday, roughly. */
  load: number;
  /** What they mostly ask about. */
  interests: InputType[];
}

export const TEAM: TeamMember[] = [
  { id: "a.iyer", role: "lawyer", load: 4, interests: ["termination", "disputes", "transfer"] },
  { id: "r.menon", role: "lawyer", load: 3, interests: ["termination", "rights", "disputes"] },
  { id: "s.khan", role: "lawyer", load: 2, interests: ["termination", "conduct", "fees"] },
  { id: "p.nair", role: "paralegal", load: 4, interests: ["fees", "term", "termination", "venue"] },
  { id: "k.rao", role: "team-manager", load: 3, interests: ["squad", "conduct", "anti-doping"] },
  { id: "d.shah", role: "finance", load: 3, interests: ["fees", "venue", "transfer"] },
  { id: "m.joseph", role: "commercial", load: 2, interests: ["rights", "venue", "fees"] },
  { id: "t.das", role: "analyst", load: 1, interests: ["other", "squad", "term"] },
];

export function findMember(id: string): TeamMember | undefined {
  return TEAM.find((member) => member.id === id);
}
