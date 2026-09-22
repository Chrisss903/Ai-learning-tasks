/**
 * Run the contract agent on one question and watch every step:
 *
 *   npm run agent -- "What is the combined retainer of Rohan Sharma and Dinesh Mendis?"
 *   npm run agent -- --workflow "..."     the fixed workflow instead
 *   npm run agent -- --max-steps 3 "..."  tighter limit, to see a safe stop
 */
import "./env.mts";

const { runAgent } = await import("../lib/agent");
const { runWorkflow } = await import("../lib/workflow");
const { resolveGenerator } = await import("../lib/generator");

const args = process.argv.slice(2);
const useWorkflow = args.includes("--workflow");
const maxStepsIndex = args.indexOf("--max-steps");
const maxSteps = maxStepsIndex === -1 ? undefined : Number(args[maxStepsIndex + 1]);
const question = args
  .filter((arg, index) => !arg.startsWith("--") && (maxStepsIndex === -1 || index !== maxStepsIndex + 1))
  .join(" ")
  .trim();

if (!question) {
  console.error('Usage: npm run agent -- [--workflow] [--max-steps N] "your question"');
  process.exit(1);
}

const indent = (text: string) => text.replace(/\n/g, "\n             ");
const clip = (text: string, length = 600) => (text.length > length ? `${text.slice(0, length)}…` : text);

console.log(`\n${useWorkflow ? "Fixed workflow" : "Agent"} · ${resolveGenerator().label}`);
console.log(`Question: ${question}\n`);

if (useWorkflow) {
  const run = await runWorkflow(question, {
    onStep: (step) => console.log(`  ${step.name.padEnd(18)} ${step.detail}  (${step.ms} ms)`),
  });
  console.log(`\nAnswer: ${run.answer}\n`);
  console.log(`1 model call · ${run.usage.inputTokens + run.usage.outputTokens} tokens · ${(run.activeMs / 1000).toFixed(1)}s active · ${(run.wallMs / 1000).toFixed(1)}s wall\n`);
} else {
  const run = await runAgent(question, {
    limits: maxSteps ? { maxSteps } : undefined,
    onStep: (step) => {
      console.log(`Step ${step.step}`);
      console.log(`  thought    ${indent(step.thought)}`);
      console.log(`  action     ${step.action} ${JSON.stringify(step.input)}`);
      console.log(`  observed   ${indent(clip(step.observation))}`);
      console.log(`  cost       ${step.usage.inputTokens} in / ${step.usage.outputTokens} out tokens · model ${step.modelMs} ms · tool ${step.toolMs} ms\n`);
    },
  });

  console.log(`Stopped: ${run.stopReason}`);
  console.log(`Answer: ${run.answer ?? "(none — the run stopped before finishing)"}\n`);
  console.log(`${run.llmCalls} model calls · ${run.usage.inputTokens + run.usage.outputTokens} tokens · ${(run.activeMs / 1000).toFixed(1)}s active · ${(run.wallMs / 1000).toFixed(1)}s wall\n`);
}
