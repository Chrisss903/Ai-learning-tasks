/**
 * Week 11: what a question is about, decided in code and logged with it.
 *
 * A complaint never carries a trace id, but it nearly always says what the
 * question was about — "on termination". This is the slice that turns that
 * phrase into a filter. The first rule that matches wins, so the narrow topics
 * come before the broad ones ("fee", "pay") that would otherwise swallow them.
 */
export type InputType =
  | "termination"
  | "disputes"
  | "anti-doping"
  | "conduct"
  | "transfer"
  | "rights"
  | "venue"
  | "fees"
  | "squad"
  | "term"
  | "other";

const RULES: [InputType, RegExp][] = [
  ["termination", /terminat|notice period|\bnotice\b.*\b(end|leave|quit|exit|release|walk)|\b(end|leave|quit|exit|release)\b.*\bnotice\b|thrown out|buyout|get out of/i],
  ["disputes", /dispute|governing law|arbitrat|jurisdiction|\bcourts?\b/i],
  ["anti-doping", /doping|whereabouts|therapeutic|tests? positive|prohibited substance/i],
  ["conduct", /level \d|demerit|offence|suspend|appeal|code of conduct|misbehav|match fixing/i],
  ["transfer", /transfer|sell-on|sell on/i],
  ["rights", /sponsor|broadcast|image rights|likeness|endorse|advertis|camera|territor|stream|show matches/i],
  ["venue", /stadium|pitch|catering|vendor|ticket|hire|insurance|home (game|match)|abandon/i],
  ["fees", /\bfees?\b|retainer|\bpay|paid|salary|earn|cost|money|invoice|revenue|charge|spend|\bcap\b/i],
  ["squad", /overseas|squad|playing eleven|report|no objection|camp|injur|medical/i],
  ["term", /how long does|run for|\bterm\b|expire|seasons?\b/i],
];

export function classifyInput(question: string): InputType {
  return RULES.find(([, pattern]) => pattern.test(question))?.[0] ?? "other";
}
