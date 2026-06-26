import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  exportMetadataArchitectureCsv,
  exportMetadataDictionaryCsv,
} from "../src/bd-export.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-bd-export-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Base dos Dados-style metadata exports", () => {
  it("exports one architecture CSV row per parsed metadata variable", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const outputPath = path.join(tempDir, "extra", "architecture", "variables.csv");
    await writeFile(layoutPath, sasLayout());

    const result = await exportMetadataArchitectureCsv({
      paths: [layoutPath],
      outputPath,
    });

    const csv = await readFile(outputPath, "utf8");

    expect(result.rowsWritten).toBe(2);
    expect(result.outputPath).toBe(outputPath);
    expect(csv.split("\n").filter(Boolean)).toEqual([
      "source_path,entry_name,parser,record_name,data_entry_name,variable_name,type,start,end,width,decimals,format,description,category_count",
      `${csvCell(layoutPath)},,sas_input,input,,UF,string,1,2,2,,$CHAR2.,Unidade da Federação,2`,
      `${csvCell(layoutPath)},,sas_input,input,,RENDA,number,3,10,8,2,8.2.,Rendimento mensal,0`,
    ]);
  });

  it("exports one dictionary CSV row per parsed value label", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const outputPath = path.join(tempDir, "extra", "dicionario.csv");
    await writeFile(layoutPath, sasLayout());

    const result = await exportMetadataDictionaryCsv({
      paths: [layoutPath],
      outputPath,
    });

    const csv = await readFile(outputPath, "utf8");

    expect(result.rowsWritten).toBe(2);
    expect(csv.split("\n").filter(Boolean)).toEqual([
      "source_path,entry_name,parser,record_name,data_entry_name,variable_name,value,label",
      `${csvCell(layoutPath)},,sas_input,input,,UF,11,Rondônia`,
      `${csvCell(layoutPath)},,sas_input,input,,UF,33,Rio de Janeiro`,
    ]);
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
label UF = "Unidade da Federação";
label RENDA = "Rendimento mensal";
@0001 UF      $CHAR2.
@0003 RENDA   8.2
format UF $UFFMT.;
`;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
