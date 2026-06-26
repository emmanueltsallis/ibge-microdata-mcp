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
    await expect(access(path.join(projectRoot, "examples", "harmonization-recipe.json"))).resolves.toBeUndefined();
    await expect(access(path.join(projectRoot, "docs", "harmonization-sources.md"))).resolves.toBeUndefined();

    const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");
    expect(readme).toContain("git clone https://github.com/emmanueltsallis/ibge-microdata-mcp.git");
    expect(readme).toContain("R with `Rscript` available on `PATH`");
    expect(readme).toContain("brew install node r");
    expect(readme).toContain("npm install -g pnpm@11.7.0");
    expect(readme).toContain("node --version");
    expect(readme).toContain("pnpm --version");
    expect(readme).toContain("Rscript --version");
    expect(readme).toContain("Rscript -e");
    expect(readme).toContain("PNADcIBGE");
    expect(readme).toContain("datazoom.social");
    expect(readme).toContain("examples/generic-workflow.md");
    expect(readme).toContain("examples/harmonization-recipe.json");
    expect(readme).toContain("docs/harmonization-sources.md");
    expect(readme).toContain("ibge_microdata_validate_recipe");
    expect(readme).toContain("ibge_microdata_apply_recipe");
    expect(readme).toContain("License");
  });
});
