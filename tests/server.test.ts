import { describe, expect, it } from "vitest";

import { SERVER_NAME, createServer } from "../src/server.js";

describe("createServer", () => {
  it("constructs the IBGE microdata MCP server", () => {
    expect(SERVER_NAME).toBe("ibge-microdata-mcp-server");
    expect(() => createServer()).not.toThrow();
  });
});
