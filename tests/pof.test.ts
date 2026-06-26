import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  exportPofZipRecordToParquet,
  readPofDictionaryManifest,
} from "../src/pof.js";

const execFileAsync = promisify(execFile);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-pof-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readPofDictionaryManifest", () => {
  it("parses POF dictionary sheets into record layouts and maps records to data ZIP entries", async () => {
    const dictionaryPath = path.join(tempDir, "Dicionarios.xls");
    const dataZipPath = path.join(tempDir, "Dados.zip");
    const dataPath = path.join(tempDir, "DOMICILIO.txt");
    createPofDictionary(dictionaryPath);
    await writeFile(dataPath, "3300000000000008000123");
    await execFileAsync("zip", ["-j", dataZipPath, dataPath]);

    const manifest = await readPofDictionaryManifest({
      dictionaryPath,
      dataZipPath,
      variableLimit: 10,
    });

    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]).toMatchObject({
      sheetName: "Domicílio",
      dataEntryName: "DOMICILIO.txt",
      variableCount: 3,
      recordLength: 22,
    });
    expect(manifest.records[0].variables).toEqual([
      {
        name: "UF",
        start: 1,
        width: 2,
        decimals: 0,
        type: "string",
        description: "Unidade da Federação",
      },
      {
        name: "V1028",
        start: 3,
        width: 15,
        decimals: 0,
        type: "number",
        description: "Fator de expansão",
      },
      {
        name: "VRENDA",
        start: 18,
        width: 5,
        decimals: 2,
        type: "number",
        description: "Rendimento com decimais",
      },
    ]);
  });

  it("filters variables by search while preserving record-level counts", async () => {
    const dictionaryPath = path.join(tempDir, "Dicionarios.xls");
    createPofDictionary(dictionaryPath);

    const manifest = await readPofDictionaryManifest({
      dictionaryPath,
      search: "expansão",
      variableLimit: 10,
    });

    expect(manifest.records[0].variableCount).toBe(3);
    expect(manifest.records[0].variables.map((variable) => variable.name)).toEqual(["V1028"]);
  });
});

describe("exportPofZipRecordToParquet", () => {
  it("converts a POF record from the data ZIP to Parquet using the Excel dictionary", async () => {
    const dictionaryPath = path.join(tempDir, "Dicionarios.xls");
    const dataPath = path.join(tempDir, "DOMICILIO.txt");
    const dataZipPath = path.join(tempDir, "Dados.zip");
    const outputPath = path.join(tempDir, "domicilio.parquet");
    createPofDictionary(dictionaryPath);
    await writeFile(dataPath, "3300000000000008000123");
    await execFileAsync("zip", ["-j", dataZipPath, dataPath]);

    const result = await exportPofZipRecordToParquet({
      dictionaryPath,
      zipPath: dataZipPath,
      recordName: "Domicílio",
      outputPath,
      selectedVariables: ["UF", "V1028", "VRENDA"],
    });

    expect(result.sourceName).toBe("DOMICILIO.txt");
    expect(result.rowsWritten).toBe(1);
    await expectParquetRows(outputPath, [{ UF: "33", V1028: 80, VRENDA: 1.23 }]);
  });
});

function createPofDictionary(dictionaryPath: string): void {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["", "", "DICIONÁRIO DAS VARIÁVEIS - POF 2017-2018"],
    ["", "", "REGISTRO – DOMICILIO"],
    [],
    ["Posição Inicial", "Tamanho", "Decimais", "Código da variável", "Descrição", "Categorias"],
    [],
    [1, 2, "", "UF", "Unidade da Federação", "11 – Rondônia"],
    [3, 15, "", "V1028", "Fator de expansão", ""],
    [18, 5, 2, "VRENDA", "Rendimento com decimais", ""],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "Domicílio");
  XLSX.writeFile(wb, dictionaryPath);
}

async function expectParquetRows(parquetPath: string, expectedRows: Array<Record<string, unknown>>): Promise<void> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const reader = await connection.runAndReadAll(`select * from read_parquet('${parquetPath.replaceAll("'", "''")}')`);
  try {
    expect(reader.getRowObjects()).toEqual(expectedRows);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
