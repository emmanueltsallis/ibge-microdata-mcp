import { describe, expect, it } from "vitest";

import {
  checkRRuntime,
  downloadPnadcWithR,
  loadDatazoomPnadcWithR,
  type RunRScript,
} from "../src/r-bridge.js";

describe("R bridge", () => {
  it("checks R runtime and requested package availability", async () => {
    const calls: Array<{ input: Record<string, unknown>; rscriptBin: string }> = [];
    const runRScript: RunRScript = async (_script, inputJson, rscriptBin) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push({ input, rscriptBin });
      return JSON.stringify({
        r_version: "R version 4.4.2",
        packages: [
          { name: "PNADcIBGE", installed: true, version: "0.7.5" },
          { name: "datazoom.social", installed: false, version: null },
        ],
      });
    };

    const result = await checkRRuntime({
      rscriptBin: "/opt/R/bin/Rscript",
      packages: ["PNADcIBGE", "datazoom.social"],
      runRScript,
    });

    expect(calls).toEqual([
      {
        rscriptBin: "/opt/R/bin/Rscript",
        input: {
          action: "status",
          packages: ["PNADcIBGE", "datazoom.social"],
        },
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.rVersion).toBe("R version 4.4.2");
    expect(result.missingPackages).toEqual(["datazoom.social"]);
    expect(result.packages).toEqual([
      { name: "PNADcIBGE", installed: true, version: "0.7.5" },
      { name: "datazoom.social", installed: false, version: null },
    ]);
  });

  it("calls PNADcIBGE through R and saves a Parquet file", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const scripts: string[] = [];
    const runRScript: RunRScript = async (script, inputJson) => {
      scripts.push(script);
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push(input);
      return JSON.stringify({
        backend: "PNADcIBGE",
        year: 2024,
        quarter: 4,
        output_path: "/tmp/pnadc-2024q4.parquet",
        output_format: "parquet",
        rows: 2,
        columns: ["UF", "VD4019"],
        package_versions: { PNADcIBGE: "0.7.5", arrow: "16.1.0" },
      });
    };

    const result = await downloadPnadcWithR({
      year: 2024,
      quarter: 4,
      vars: ["UF", "VD4019"],
      outputPath: "/tmp/pnadc-2024q4.parquet",
      savedir: "/tmp/pnadc-cache",
      rscriptBin: "Rscript",
      runRScript,
    });

    expect(scripts[0]).toContain('library("PNADcIBGE")');
    expect(scripts[0]).toContain("dir.create(args$savedir, recursive = TRUE, showWarnings = FALSE)");
    expect(calls).toEqual([
      {
        action: "pnadc_get",
        year: 2024,
        quarter: 4,
        vars: ["UF", "VD4019"],
        output_path: "/tmp/pnadc-2024q4.parquet",
        output_format: "parquet",
        selected: true,
        labels: true,
        deflator: true,
        design: false,
        reload: true,
        savedir: "/tmp/pnadc-cache",
        defyear: null,
        defperiod: null,
      },
    ]);
    expect(result).toMatchObject({
      backend: "PNADcIBGE",
      year: 2024,
      quarter: 4,
      outputPath: "/tmp/pnadc-2024q4.parquet",
      outputFormat: "parquet",
      rows: 2,
      columns: ["UF", "VD4019"],
    });
  });

  it("calls datazoom.social through R and returns produced files", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runRScript: RunRScript = async (_script, inputJson) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      calls.push(input);
      return JSON.stringify({
        backend: "datazoom.social",
        output_dir: "/tmp/datazoom",
        years: [2024],
        quarters: [1, 2],
        panel: "basic",
        raw_data: false,
        output_format: "parquet",
        save_quarterly: false,
        files: [
          {
            path: "/tmp/datazoom/pnadc_panel_basic.parquet",
            relative_path: "pnadc_panel_basic.parquet",
            bytes: 1234,
          },
        ],
        package_versions: { "datazoom.social": "0.1.0" },
      });
    };

    const result = await loadDatazoomPnadcWithR({
      outputDir: "/tmp/datazoom",
      years: [2024],
      quarters: [1, 2],
      panel: "basic",
      outputFormat: "parquet",
      saveQuarterly: false,
      vars: ["VD4019"],
      runRScript,
    });

    expect(calls).toEqual([
      {
        action: "datazoom_load_pnadc",
        output_dir: "/tmp/datazoom",
        years: [2024],
        quarters: [1, 2],
        panel: "basic",
        raw_data: false,
        output_format: "parquet",
        save_quarterly: false,
        vars: ["VD4019"],
      },
    ]);
    expect(result).toMatchObject({
      backend: "datazoom.social",
      outputDir: "/tmp/datazoom",
      years: [2024],
      quarters: [1, 2],
      panel: "basic",
      outputFormat: "parquet",
      saveQuarterly: false,
      files: [{ path: "/tmp/datazoom/pnadc_panel_basic.parquet", bytes: 1234 }],
    });
  });
});
