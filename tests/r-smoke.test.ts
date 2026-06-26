import { describe, expect, it } from "vitest";

import { checkRRuntime } from "../src/r-bridge.js";

const runRSmoke = process.env.RUN_R_SMOKE === "1";

describe.skipIf(!runRSmoke)("R bridge smoke test", () => {
  it("checks local Rscript and baseline R package availability", async () => {
    const result = await checkRRuntime();

    expect(result.rVersion).toBeTruthy();
    expect(result.ok).toBe(true);
    expect(result.missingPackages).toEqual([]);
    expect(result.packages.map((packageStatus) => packageStatus.name)).toEqual(
      expect.arrayContaining(["PNADcIBGE", "datazoom.social", "jsonlite", "arrow"])
    );
  });
});
