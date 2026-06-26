import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMetadataInventory, searchMetadataVariables } from "../src/metadata.js";

const execFileAsync = promisify(execFile);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-metadata-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildMetadataInventory", () => {
  it("combines SAS/TXT layouts and POF-style Excel dictionaries into one metadata inventory", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dictionaryPath = path.join(tempDir, "Dicionarios.xlsx");
    await writeFile(layoutPath, sasLayout());
    createPofDictionary(dictionaryPath);

    const result = await buildMetadataInventory({
      paths: [layoutPath, dictionaryPath],
      variableLimit: 10,
    });

    expect(result.parsedSources).toBe(2);
    expect(result.records.map((record) => record.parser)).toEqual(["sas_input", "excel_dictionary"]);
    expect(result.records[0].variables[0]).toMatchObject({
      name: "UF",
      categories: [
        { value: "11", label: "Rondônia" },
        { value: "33", label: "Rio de Janeiro" },
      ],
    });
    expect(result.records[1].variables.map((variable) => variable.name)).toEqual(["UF", "V1028"]);
  });

  it("scans documentation ZIPs for candidate dictionary/layout entries", async () => {
    const layoutPath = path.join(tempDir, "Layout_Microdados.txt");
    const ignoredPath = path.join(tempDir, "Dados.txt");
    const zipPath = path.join(tempDir, "Documentacao.zip");
    await writeFile(layoutPath, sasLayout());
    await writeFile(ignoredPath, "33000000000000080");
    await execFileAsync("zip", ["-j", zipPath, layoutPath, ignoredPath]);

    const result = await buildMetadataInventory({
      zipPaths: [zipPath],
      variableLimit: 10,
    });

    expect(result.parsedSources).toBe(1);
    expect(result.sources[0]).toMatchObject({
      path: zipPath,
      entryName: "Layout_Microdados.txt",
      parser: "sas_input",
      status: "parsed",
    });
    expect(result.records[0].variables.map((variable) => variable.name)).toEqual(["UF", "RENDA"]);
  });
});

describe("searchMetadataVariables", () => {
  it("searches variable names, descriptions, and parsed categories", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    await writeFile(layoutPath, sasLayout());

    const result = await searchMetadataVariables({
      paths: [layoutPath],
      query: "rondonia",
    });

    expect(result.totalMatches).toBe(1);
    expect(result.matches[0]).toMatchObject({
      recordName: "input",
      variable: {
        name: "UF",
        categories: [
          { value: "11", label: "Rondônia" },
          { value: "33", label: "Rio de Janeiro" },
        ],
      },
    });
  });
});

function sasLayout(): string {
  return `
proc format;
value $UFFMT
  '11' = 'Rondônia'
  '33' = 'Rio de Janeiro'
;
run;
label RENDA = "Rendimento mensal";
@0001 UF      $CHAR2.
@0003 RENDA   8.2
format UF $UFFMT.;
`;
}

function createPofDictionary(dictionaryPath: string): void {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["", "", "DICIONÁRIO DAS VARIÁVEIS - POF 2017-2018"],
    [],
    ["Posição Inicial", "Tamanho", "Decimais", "Código da variável", "Descrição", "Categorias"],
    [1, 2, "", "UF", "Unidade da Federação", "11 – Rondônia 33 – Rio de Janeiro"],
    [3, 15, "", "V1028", "Fator de expansão", ""],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "Domicílio");
  XLSX.writeFile(wb, dictionaryPath);
}
