#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} started`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
