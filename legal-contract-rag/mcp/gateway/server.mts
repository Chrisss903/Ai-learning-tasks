/**
 * Week 9 bonus: one front door for every MCP server.
 *
 *   agent ──stdio──▶ gateway ──stdio──▶ clause-search
 *                            └─stdio──▶ contract-repository
 *
 * To the agent this is just another MCP server: it answers tools/list with
 * every tool behind it and forwards each tools/call to the server that owns
 * the tool. On the way it does two things no single server can:
 *
 *   - checks the caller's token scope, tool by tool, before anything runs;
 *   - writes one audit line per tools/call: caller, tool, contract id, decision.
 *
 * A denial goes back to the model as an ordinary tool result that says what
 * happened and what it may do instead, so it can recover instead of guessing.
 *
 * Environment
 *   GATEWAY_TOKEN       the caller's token; only its sha256 is in the config
 *   GATEWAY_CONFIG      downstream servers + callers (default mcp.gateway.json)
 *   GATEWAY_AUDIT_LOG   default logs/gateway-audit.jsonl
 */
import { createHash } from "crypto";
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// stdout is the protocol channel; anything printed goes to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

const { connectServers } = await import("../../lib/mcp-client");
type McpConfig = import("../../lib/mcp-client").McpConfig;
type DiscoveredTool = import("../../lib/mcp-client").DiscoveredTool;

/** A token's identity and scope. Scopes are "server/tool", "server/*" or "*". */
interface Caller {
  caller: string;
  allow: string[];
}

interface GatewayConfig extends McpConfig {
  /** Keyed by "sha256:<hex of the token>", so the file never holds a token. */
  callers: Record<string, Caller>;
}

const configFile = path.resolve(process.env.GATEWAY_CONFIG ?? "mcp.gateway.json");
const config: GatewayConfig = JSON.parse(readFileSync(configFile, "utf-8"));

const auditFile = process.env.GATEWAY_AUDIT_LOG ?? "logs/gateway-audit.jsonl";
mkdirSync(path.dirname(auditFile), { recursive: true });

const tokenHash = createHash("sha256").update(process.env.GATEWAY_TOKEN ?? "").digest("hex");
const identity = config.callers[`sha256:${tokenHash}`];
if (!identity) {
  console.error("gateway: GATEWAY_TOKEN is missing or not a known caller");
  process.exit(1);
}

const downstream = await connectServers({ mcpServers: config.mcpServers }, path.dirname(configFile), "mcp-gateway");

const scopeOf = (tool: DiscoveredTool) => `${tool.server}/${tool.name}`;

const allowed = (tool: DiscoveredTool) =>
  identity.allow.some(
    (scope) => scope === "*" || scope === scopeOf(tool) || scope === `${tool.server}/*`,
  );

const CONTRACT_ID = /\b[A-Z]{2,4}(?:-[A-Z]{2})?-\d{3,4}(?:-\d{2,3})*\b/i;

/** The contract a call is about: its contract_id, or the first id in any argument. */
function contractIdOf(args: Record<string, unknown>): string | null {
  if (typeof args.contract_id === "string" && args.contract_id.trim()) return args.contract_id.trim().toUpperCase();
  for (const value of Object.values(args)) {
    const match = typeof value === "string" ? value.match(CONTRACT_ID) : null;
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function audit(entry: Record<string, unknown>) {
  appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const text = (body: string, isError = false) => ({ content: [{ type: "text" as const, text: body }], isError });

function denial(tool: DiscoveredTool): string {
  const sameServer = downstream.tools.filter((t) => t.server === tool.server && allowed(t)).map((t) => t.name);

  return [
    `Denied by the MCP gateway: caller "${identity.caller}" has no permission for ${scopeOf(tool)}.`,
    "This is a permission decision, not a lookup result — it says nothing about the data that tool would have returned, so do not fill the gap with an assumption.",
    sameServer.length
      ? `On ${tool.server} this token may use: ${sameServer.join(", ")}.`
      : `This token may use nothing on ${tool.server}.`,
    `If the answer depends on ${tool.name}, say what you could not check and that it needs the ${scopeOf(tool)} permission.`,
  ].join(" ");
}

const server = new Server(
  { name: "mcp-gateway", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: "Front door for the contract team's MCP servers. Calls are scoped per caller and audited.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: downstream.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const started = Date.now();
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const tool = downstream.tools.find((candidate) => candidate.name === request.params.name);
  const entry = { caller: identity.caller, contract_id: contractIdOf(args) };

  if (!tool) {
    audit({ ...entry, tool: request.params.name, decision: "unknown-tool" });
    return text(`No tool "${request.params.name}" behind this gateway. Tools: ${downstream.tools.map((t) => t.name).join(", ")}.`, true);
  }

  if (!allowed(tool)) {
    audit({ ...entry, tool: scopeOf(tool), decision: "deny" });
    return text(denial(tool), true);
  }

  const result = await tool.call(args);
  audit({ ...entry, tool: scopeOf(tool), decision: "allow", outcome: result.isError ? "error" : "ok", ms: Date.now() - started });
  return text(result.text, result.isError);
});

// Whoever started us may go away without a word; take the servers behind us down too.
const shutdown = async () => {
  await downstream.close().catch(() => {});
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await server.connect(new StdioServerTransport());
