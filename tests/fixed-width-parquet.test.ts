import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  exportFixedWidthFileToParquet,
  exportFixedWidthZipEntryToParquet,
} from "../src/fixed-width-parquet.js";

const execFileAsync = promisify(execFile);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-parquet-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("exportFixedWidthFileToParquet", () => {
  it("converts selected fixed-width variables into a queryable Parquet file", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    const parquetPath = path.join(tempDir, "sample.parquet");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
@0018 VD4019  8.    /* Rendimento */
`
    );
    await writeFile(
      dataPath,
      [
        sampleLine({ uf: "33", weight: "000000000000080", income: "00001000" }),
        sampleLine({ uf: "35", weight: "000000000000010", income: "00010000" })
      ].join("\n")
    );

    const result = await exportFixedWidthFileToParquet({
      layoutPath,
      dataPath,
      outputPath: parquetPath,
      selectedVariables: ["UF", "V1028", "VD4019"]
    });

    expect(result.rowsRead).toBe(2);
    expect(result.rowsWritten).toBe(2);
    expect(result.variables.map((variable) => variable.name)).toEqual(["UF", "V1028", "VD4019"]);
    await expectParquetRows(parquetPath, [
      { UF: "33", V1028: 80, VD4019: 1000 },
      { UF: "35", V1028: 10, VD4019: 10000 }
    ]);
  });

  it("can sample rows with rowLimit before writing Parquet", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    const parquetPath = path.join(tempDir, "sample-limit.parquet");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
`
    );
    await writeFile(
      dataPath,
      [
        sampleLine({ uf: "33", weight: "000000000000080", income: "00001000" }),
        sampleLine({ uf: "35", weight: "000000000000010", income: "00010000" })
      ].join("\n")
    );

    const result = await exportFixedWidthFileToParquet({
      layoutPath,
      dataPath,
      outputPath: parquetPath,
      rowLimit: 1
    });

    expect(result.rowsRead).toBe(1);
    expect(result.rowsWritten).toBe(1);
    await expectParquetRows(parquetPath, [{ UF: "33", V1028: 80 }]);
  });
});

describe("exportFixedWidthZipEntryToParquet", () => {
  it("streams a fixed-width ZIP entry into Parquet without extracting it first", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    const zipPath = path.join(tempDir, "sample.zip");
    const parquetPath = path.join(tempDir, "sample-zip.parquet");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
`
    );
    await writeFile(dataPath, sampleLine({ uf: "33", weight: "000000000000080", income: "00001000" }));
    await execFileAsync("zip", ["-j", zipPath, dataPath]);

    const result = await exportFixedWidthZipEntryToParquet({
      layoutPath,
      zipPath,
      entryName: "sample.txt",
      outputPath: parquetPath
    });

    expect(result.sourceName).toBe("sample.txt");
    expect(result.rowsWritten).toBe(1);
    await expectParquetRows(parquetPath, [{ UF: "33", V1028: 80 }]);
  });
});

async function expectParquetRows(parquetPath: string, expectedRows: Array<Record<string, unknown>>): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const reader = await connection.runAndReadAll(`select * from read_parquet('${parquetPath.replaceAll("'", "''")}')`);
  expect(reader.getRowObjects()).toEqual(expectedRows);
}

function sampleLine({ uf, weight, income }: { uf: string; weight: string; income: string }): string {
  return `${uf}${weight}${income}`;
}
