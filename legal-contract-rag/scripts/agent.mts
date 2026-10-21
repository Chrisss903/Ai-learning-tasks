/**
 * Run the contract agent on one question and watch every step:
 *
 *   npm run agent -- "What is the combined retainer of Rohan Sharma and Dinesh Mendis?"
 *   npm run agent -- --workflow "..."     the fixed workflow instead
 *   npm run agent -- --squad "..."        the week 10 squad: a manager and two specialists
 *   npm run agent -- --max-steps 3 "..."  tighter limit, to see a safe stop
 *   npm run agent -- --save trace.json "..."  also write the whole run as JSON
 *
 * Week 9: the agent's tools come from the MCP servers in mcp.config.json (or
 * MCP_CONFIG). Each step shows which server ran the tool.
 */
import "./env.mts";
import { writeFileSync } from "fs";

const { runAgent } = await import("../lib/agent");
const { runWorkflow } = await import("../lib/workflow");
const { runSquad } = await import("../lib/squad");
const { resolveGenerator } = await import("../lib/generator");
const { closeTools, configPath, connectFromConfig } = await import("../lib/mcp-client");

const args = process.argv.slice(2);
const useWorkflow = args.includes("--workflow");
const useSquad = args.includes("--squad");
const valueOf = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const flagValues = new Set(
  ["--max-steps", "--save"].map((flag) => args.indexOf(flag)).filter((i) => i !== -1).map((i) => i + 1),
);
const maxSteps = valueOf("--max-steps") ? Number(valueOf("--max-steps")) : undefined;
const saveTo = valueOf("--save");
const question = args
  .filter((arg, index) => !arg.startsWith("--") && !flagValues.has(index))
  .join(" ")
  .trim();

if (!question) {
  console.error('Usage: npm run agent -- [--workflow | --squad] [--max-steps N] [--save file.json] "your question"');
  process.exit(1);
}

const indent = (text: string) => text.replace(/\n/g, "\n             ");
const clip = (text: string, length = 600) => (text.length > length ? `${text.slice(0, length)}…` : text);

console.log(`\n${useWorkflow ? "Fixed workflow" : useSquad ? "Squad" : "Agent"} · ${resolveGenerator().label}`);
console.log(`Question: ${question}\n`);

if (useSquad) {
  // Specialists run at once, so their steps interleave; each line names its task.
  const run = await runSquad(question, {
    onPlan: (thought, tasks) => {
      console.log(`manager    plan: ${indent(thought)}`);
      for (const [index, task] of tasks.entries()) {
        console.log(`           t${index + 1} → ${task.to} · ${task.contractId ?? "no contract named"} · ${task.task}`);
      }
      console.log();
    },
    onTask: (task) => console.log(`${task.id.padEnd(10)} ${task.states.at(-1)?.state}`),
    onStep: (task, step) => {
      console.log(`${task.id.padEnd(10)} step ${step.step}  ${step.action} ${JSON.stringify(step.input)}${step.server ? `   [mcp: ${step.server}]` : ""}`);
      console.log(`           thought    ${indent(step.thought)}`);
      console.log(`           observed   ${indent(clip(step.observation, 300))}`);
    },
  });

  console.log(`\nStopped: ${run.stopReason}`);
  console.log(`Answer: ${run.answer ?? "(none — the manager produced no usable plan)"}\n`);
  for (const [role, use] of Object.entries(run.byRole)) {
    console.log(`  ${role.padEnd(18)} ${use.calls} calls · ${use.inputTokens} in / ${use.outputTokens} out tokens`);
  }
  console.log(
    `\n${run.llmCalls} model calls · ${run.usage.inputTokens + run.usage.outputTokens} tokens · ` +
      `${(run.activeMs / 1000).toFixed(1)}s critical path · ${(run.busyMs / 1000).toFixed(1)}s summed · ${(run.wallMs / 1000).toFixed(1)}s wall\n`,
  );

  if (saveTo) {
    writeFileSync(saveTo, JSON.stringify({ ranAt: new Date().toISOString(), generator: resolveGenerator().label, ...run }, null, 2));
    console.log(`saved → ${saveTo}\n`);
  }
} else if (useWorkflow) {
  const run = await runWorkflow(question, {
    onStep: (step) => console.log(`  ${step.name.padEnd(18)} ${step.detail}  (${step.ms} ms)`),
  });
  console.log(`\nAnswer: ${run.answer}\n`);
  console.log(`1 model call · ${run.usage.inputTokens + run.usage.outputTokens} tokens · ${(run.activeMs / 1000).toFixed(1)}s active · ${(run.wallMs / 1000).toFixed(1)}s wall\n`);
} else {
  const connection = await connectFromConfig();
  console.log(`MCP config ${configPath().replace(`${process.cwd()}/`, "")} → ${connection.tools.length} tools discovered via tools/list:`);
  for (const server of connection.servers) {
    console.log(`  ${server.name.padEnd(20)} ${server.tools.map((tool) => tool.name).join(", ")}`);
  }
  for (const { name } of connection.failed) console.log(`  ${name.padEnd(20)} (did not start)`);
  console.log();

  const run = await runAgent(question, {
    limits: maxSteps ? { maxSteps } : undefined,
    onStep: (step) => {
      console.log(`Step ${step.step}`);
      console.log(`  thought    ${indent(step.thought)}`);
      console.log(`  action     ${step.action} ${JSON.stringify(step.input)}${step.server ? `   [mcp: ${step.server}]` : ""}`);
      console.log(`  observed   ${indent(clip(step.observation))}`);
      console.log(`  cost       ${step.usage.inputTokens} in / ${step.usage.outputTokens} out tokens · model ${step.modelMs} ms · tool ${step.toolMs} ms\n`);
    },
  });

  console.log(`Stopped: ${run.stopReason}`);
  console.log(`Answer: ${run.answer ?? "(none — the run stopped before finishing)"}\n`);
  console.log(`${run.llmCalls} model calls · ${run.usage.inputTokens + run.usage.outputTokens} tokens · ${(run.activeMs / 1000).toFixed(1)}s active · ${(run.wallMs / 1000).toFixed(1)}s wall\n`);

  if (saveTo) {
    writeFileSync(
      saveTo,
      JSON.stringify({ ranAt: new Date().toISOString(), generator: resolveGenerator().label, mcpConfig: configPath().replace(`${process.cwd()}/`, ""), ...run }, null, 2),
    );
    console.log(`saved → ${saveTo}\n`);
  }
}

await closeTools();
