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

  it("falls back to a generic Excel dictionary parser when sheet headers differ from POF", async () => {
    const dictionaryPath = path.join(tempDir, "GenericDictionary.xlsx");
    createGenericExcelDictionary(dictionaryPath);

    const result = await buildMetadataInventory({
      paths: [dictionaryPath],
      variableLimit: 10,
    });

    expect(result.parsedSources).toBe(1);
    expect(result.sources[0].diagnostics).toEqual([
      {
        parser: "excel_dictionary",
        status: "skipped",
        message: "No POF-style Excel dictionary sheets found",
      },
      {
        parser: "excel_dictionary",
        status: "parsed",
        message: "Parsed 1 generic Excel dictionary sheet(s)",
      },
    ]);
    expect(result.records[0]).toMatchObject({
      parser: "excel_dictionary",
      recordName: "Moradores",
      variableCount: 3,
      recordLength: 22,
    });
    expect(result.records[0].variables).toEqual([
      {
        name: "UF",
        type: "string",
        start: 1,
        end: 2,
        width: 2,
        description: "Unidade da Federação",
        categories: [
          { value: "11", label: "Rondônia" },
          { value: "33", label: "Rio de Janeiro" },
        ],
      },
      {
        name: "PESO",
        type: "number",
        start: 3,
        end: 17,
        width: 15,
        description: "Peso amostral",
        categories: [],
      },
      {
        name: "RENDA",
        type: "number",
        start: 18,
        end: 22,
        width: 5,
        decimals: 2,
        description: "Rendimento",
        categories: [],
      },
    ]);
  });

  it("parses generic delimited text dictionary tables", async () => {
    const dictionaryPath = path.join(tempDir, "layout.txt");
    await writeFile(
      dictionaryPath,
      [
        "Inicio|Tamanho|Variavel|Descricao|Categorias",
        "1|2|UF|Unidade da Federação|11 - Rondônia; 33 - Rio de Janeiro",
        "3|15|PESO|Peso amostral|",
      ].join("\n")
    );

    const result = await buildMetadataInventory({
      paths: [dictionaryPath],
      variableLimit: 10,
    });

    expect(result.sources[0]).toMatchObject({
      parser: "text_dictionary",
      status: "parsed",
    });
    expect(result.records[0].variables.map((variable) => variable.name)).toEqual(["UF", "PESO"]);
    expect(result.records[0].variables[0].categories).toEqual([
      { value: "11", label: "Rondônia" },
      { value: "33", label: "Rio de Janeiro" },
    ]);
  });

  it("parses loose plain-text start-width-variable rows when there is no header", async () => {
    const dictionaryPath = path.join(tempDir, "legacy-layout.txt");
    await writeFile(
      dictionaryPath,
      [
        "1 2 UF Unidade da Federação 11 - Rondônia 33 - Rio de Janeiro",
        "3 15 PESO Peso amostral",
      ].join("\n")
    );

    const result = await buildMetadataInventory({
      paths: [dictionaryPath],
      variableLimit: 10,
    });

    expect(result.sources[0]).toMatchObject({
      parser: "text_dictionary",
      status: "parsed",
    });
    expect(result.records[0]).toMatchObject({
      recordName: "legacy-layout",
      variableCount: 2,
    });
    expect(result.records[0].variables[0]).toMatchObject({
      name: "UF",
      start: 1,
      width: 2,
    });
  });

  it("returns parser diagnostics when a metadata candidate is not structured enough", async () => {
    const dictionaryPath = path.join(tempDir, "notes.txt");
    await writeFile(dictionaryPath, "This file mentions variables in prose but has no positions or widths.");

    const result = await buildMetadataInventory({
      paths: [dictionaryPath],
    });

    expect(result.parsedSources).toBe(0);
    expect(result.sources[0]).toMatchObject({
      parser: "unsupported",
      status: "skipped",
      message: "No registered parser could convert this metadata file into structured variables",
    });
    expect(result.sources[0].diagnostics).toEqual([
      {
        parser: "sas_input",
        status: "skipped",
        message: "No SAS INPUT @position layout variables found",
      },
      {
        parser: "text_dictionary",
        status: "skipped",
        message: "No generic text dictionary table found; tried delimited, whitespace, and loose start-width-variable rows",
      },
    ]);
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

function createGenericExcelDictionary(dictionaryPath: string): void {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Arquivo de layout genérico"],
    [],
    ["Start", "Width", "Variable", "Description", "Decimals", "Value labels"],
    [1, 2, "UF", "Unidade da Federação", "", "11 - Rondônia; 33 - Rio de Janeiro"],
    [3, 15, "PESO", "Peso amostral", "", ""],
    [18, 5, "RENDA", "Rendimento", 2, ""],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "Moradores");
  XLSX.writeFile(wb, dictionaryPath);
}
