import { appendFileSync, readFileSync } from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as ToolDefinition } from "@modelcontextprotocol/sdk/types.js";

/**
 * Week 9: the agent's side of MCP — the client, running inside the host.
 *
 * The agent no longer has a list of tools. It has a config file naming MCP
 * servers; this module launches each one, asks it what it offers (tools/list),
 * and hands the agent whatever comes back. Adding a server is a config change:
 * nothing here, or in the agent, knows any tool by name.
 *
 * No model runs here or in a server. The host calls the model, the model picks
 * a tool, and this module forwards that one call (tools/call) and returns text.
 */
export interface ServerConfig {
  command: string;
  args?: string[];
  /**
   * Added to a minimal inherited environment (PATH, HOME, …): a server never
   * sees the host's API keys unless the config hands them over. `${NAME}` is
   * read from the host's environment, so secrets stay out of the file.
   */
  env?: Record<string, string>;
  /** Relative to the config file. */
  cwd?: string;
}

export interface McpConfig {
  mcpServers: Record<string, ServerConfig>;
}

export type InputSchema = ToolDefinition["inputSchema"];

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export interface DiscoveredTool {
  /** What the model calls it — the server's own name, unless two servers clash. */
  name: string;
  server: string;
  description: string;
  inputSchema: InputSchema;
  call(args: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface ConnectedServer {
  name: string;
  /** How the server introduced itself in its initialize result. */
  info: { name: string; version: string } | undefined;
  /** tools/list, exactly as the server returned it. */
  tools: ToolDefinition[];
}

export interface McpConnection {
  servers: ConnectedServer[];
  /** Servers in the config that did not start; their tools are simply absent. */
  failed: { name: string; reason: string }[];
  tools: DiscoveredTool[];
  close(): Promise<void>;
}

export function configPath(): string {
  return path.resolve(process.cwd(), process.env.MCP_CONFIG ?? "mcp.config.json");
}

export function loadConfig(file = configPath()): McpConfig {
  const config = JSON.parse(readFileSync(file, "utf-8"));
  if (!config?.mcpServers || typeof config.mcpServers !== "object") {
    throw new Error(`${file} has no "mcpServers" object`);
  }
  return config;
}

const expand = (value: string) =>
  value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");

/**
 * Every JSON-RPC message, both ways, appended to MCP_WIRE_LOG as one JSON line.
 * Off unless asked for — it is how the raw handshake is captured, once.
 */
function tap(server: string, inner: Transport): Transport {
  const file = process.env.MCP_WIRE_LOG;
  if (!file) return inner;

  const log = (direction: "client→server" | "server→client", message: unknown) =>
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), server, direction, message })}\n`,
    );

  const tapped: Transport = {
    async start() {
      inner.onmessage = (message, extra) => {
        log("server→client", message);
        tapped.onmessage?.(message, extra);
      };
      inner.onclose = () => tapped.onclose?.();
      inner.onerror = (error) => tapped.onerror?.(error);
      await inner.start();
    },
    async send(message, options) {
      log("client→server", message);
      await inner.send(message, options);
    },
    close: () => inner.close(),
  };

  return tapped;
}

async function connectServer(
  name: string,
  config: ServerConfig,
  baseDir: string,
  clientName: string,
): Promise<{ client: Client; server: ConnectedServer }> {
  const env = Object.fromEntries(
    Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value)]),
  );

  const transport = new StdioClientTransport({
    command: config.command,
    args: (config.args ?? []).map(expand),
    env: { ...getDefaultEnvironment(), ...env },
    cwd: path.resolve(baseDir, config.cwd ?? "."),
    stderr: process.env.MCP_DEBUG ? "inherit" : "ignore",
  });

  const client = new Client({ name: clientName, version: "9.0.0" });

  try {
    await client.connect(tap(name, transport));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP server "${name}" did not start: ${reason}. Set MCP_DEBUG=1 to see its stderr.`);
  }

  const tools: ToolDefinition[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  return { client, server: { name, info: client.getServerVersion(), tools } };
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (Array.isArray(result.content) ? result.content : []) as {
      type: string;
      text?: string;
    }[];

    const text = content
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type} content]`))
      .join("\n")
      .trim();

    return { text: text || "(the tool returned nothing)", isError: Boolean(result.isError) };
  } catch (error) {
    // A protocol-level failure — bad arguments, an unknown tool, a server that
    // died — still goes back to the model, which may be able to work around it.
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}

/**
 * Starts every server in a config and gathers what their tools/list returned.
 * One server failing to start costs its tools, not the run: it is reported and
 * left out. Only when none start is that an error.
 */
export async function connectServers(
  config: McpConfig,
  baseDir: string,
  clientName = "contract-agent",
): Promise<McpConnection> {
  const names = Object.keys(config.mcpServers);
  const settled = await Promise.allSettled(
    names.map((name) => connectServer(name, config.mcpServers[name], baseDir, clientName)),
  );

  const connected = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const close = async () => {
    await Promise.all(connected.map(({ client }) => client.close()));
  };

  const failed = settled.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ name: names[index], reason: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
      : [],
  );
  for (const { reason } of failed) console.error(`warning: ${reason}`);

  if (names.length && !connected.length) {
    throw new Error(`No MCP server started: ${failed.map((f) => f.reason).join("; ")}`);
  }

  const tools: DiscoveredTool[] = [];
  const taken = new Set<string>();

  for (const { client, server } of connected) {
    for (const definition of server.tools) {
      // Two servers may both offer a "search"; the second is reached by server name.
      const name = taken.has(definition.name) ? `${server.name}.${definition.name}` : definition.name;
      taken.add(name);

      tools.push({
        name,
        server: server.name,
        description: definition.description ?? "",
        inputSchema: definition.inputSchema,
        call: (args) => callTool(client, definition.name, args),
      });
    }
  }

  return { servers: connected.map(({ server }) => server), failed, tools, close };
}

let shared: Promise<McpConnection> | null = null;

/** The agent's connection: every server in the config, started once per process. */
export function connectFromConfig(): Promise<McpConnection> {
  shared ??= (async () => {
    const file = configPath();
    return connectServers(loadConfig(file), path.dirname(file));
  })();
  return shared;
}

export async function discoverTools(): Promise<DiscoveredTool[]> {
  return (await connectFromConfig()).tools;
}

/** Stops the server processes. Scripts call it last, or they never exit. */
export async function closeTools(): Promise<void> {
  if (!shared) return;
  const connection = shared;
  shared = null;
  await (await connection.catch(() => null))?.close();
}
