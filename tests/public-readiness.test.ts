import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("public repository readiness", () => {
  it("has GitHub repository metadata and public discovery keywords", async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
      keywords?: string[];
    };

    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/emmanueltsallis/ibge-microdata-mcp.git",
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/emmanueltsallis/ibge-microdata-mcp/issues");
    expect(packageJson.homepage).toBe("https://github.com/emmanueltsallis/ibge-microdata-mcp#readme");
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(["mcp", "ibge", "microdata", "pnad", "pof", "duckdb", "parquet"])
    );
  });

  it("ships license and generic example docs for public users", async () => {
    await expect(access(path.join(projectRoot, "LICENSE"))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, "examples", "generic-workflow.md"))).resolves.toBeUndefined();

    const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
    expect(readme).toContain("git clone https://github.com/emmanueltsallis/ibge-microdata-mcp.git");
    expect(readme).toContain("examples/generic-workflow.md");
    expect(readme).toContain("License");
  });
});
