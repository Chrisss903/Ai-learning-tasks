/**
 * Week 9: what the agent can see — every tool, straight from tools/list on the
 * servers in the MCP config. Nothing here is typed in by hand.
 *
 *   npm run mcp:tools
 *   npm run mcp:tools -- --save tools.json     also keep the raw tools/list results
 *   MCP_CONFIG=mcp.frontdoor.json npm run mcp:tools
 */
import "./env.mts";
import { writeFileSync } from "fs";

const { closeTools, configPath, connectFromConfig } = await import("../lib/mcp-client");

const args = process.argv.slice(2);
const saveIndex = args.indexOf("--save");
const saveTo = saveIndex === -1 ? undefined : args[saveIndex + 1];
const config = configPath().replace(`${process.cwd()}/`, "");

const connection = await connectFromConfig();

console.log(`\nMCP config: ${config}`);
for (const server of connection.servers) {
  console.log(`\n${server.name}  (initialize → ${server.info?.name} ${server.info?.version})  ${server.tools.length} tool(s) from tools/list`);
  for (const tool of server.tools) console.log(`  - ${tool.name}`);
}
for (const { name } of connection.failed) console.log(`\n${name}  DID NOT START — no tools from it`);
console.log(`\n${connection.tools.length} tools: ${connection.tools.map((tool) => tool.name).join(", ")}\n`);

if (saveTo) {
  writeFileSync(
    saveTo,
    JSON.stringify(
      {
        listedAt: new Date().toISOString(),
        config,
        count: connection.tools.length,
        names: connection.tools.map((tool) => tool.name),
        servers: connection.servers,
        failed: connection.failed,
      },
      null,
      2,
    ),
  );
  console.log(`saved → ${saveTo}\n`);
}

await closeTools();
