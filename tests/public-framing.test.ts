import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

describe("public repository framing", () => {
  it("keeps the README generic instead of centered on a worker/employer income use case", async () => {
    const readme = await readFile(path.join(projectRoot, "README.md"), "utf8");

    expect(readme).toContain("## Core Generic Tools");
    expect(readme).toContain("## Optional Survey-Specific Helpers");
    expect(readme).toContain("ibge_microdata_weighted_distribution");
    expect(readme).toContain("valueColumn");
    expect(readme).toContain("weightColumn");
    expect(readme).toContain("groupColumn");
    expect(readme.indexOf("## Core Generic Tools")).toBeLessThan(
      readme.indexOf("## Optional Survey-Specific Helpers")
    );
    expect(readme.indexOf("ibge_microdata_query_parquet")).toBeLessThan(
      readme.indexOf("ibge_microdata_pnadc_analyze_file")
    );
    expect(readme).not.toMatch(/employer_with_cnpj|employer_without_cnpj|own_account|work_group|VD4009|V4019|VD4019/);
  });

  it("keeps MCP descriptions public-generic rather than tied to the original labor-share analysis", async () => {
    const serverSource = await readFile(path.join(projectRoot, "src", "server.ts"), "utf8");

    expect(serverSource).toContain("ibge_microdata_weighted_distribution");
    expect(serverSource).not.toMatch(/employees, employers|employers with CNPJ|own-account workers|work_group/);
  });
});
