import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import {
  describeParquetViewsTool,
  discoverMicrodataTool,
  downloadFileTool,
  extractZipEntryTool,
  fixedWidthFileToParquetTool,
  fixedWidthZipToParquetTool,
  inspectLayoutTool,
  listCachedFilesTool,
  listDirectoryTool,
  listFilesTool,
  listSurveysTool,
  pnadcAnalyzeFileTool,
  pnadcAnalyzeZipTool,
  pofDictionaryManifestTool,
  pofZipRecordToParquetTool,
  profileParquetViewsTool,
  queryParquetTool,
  queryParquetViewsTool,
  remoteFileInfoTool,
  weightedDistributionTool,
  zipEntriesTool
} from "../src/tools.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-tools-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("listSurveysTool", () => {
  it("returns supported microdata survey families", () => {
    const result = listSurveysTool();
    expect(result.structured.surveys.map((survey) => survey.id)).toEqual(["pnadc_trimestral", "pof"]);
    expect(result.markdown).toContain("PNAD Contínua Trimestral");
  });
});

describe("listFilesTool", () => {
  it("lists PNAD Contínua quarterly ZIPs for a year from the official directory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response('<a href="PNADC_042024_20250815.zip">file</a>', { status: 200 });
      })
    );

    const result = await listFilesTool({ survey: "pnadc_trimestral", year: 2024 });
    expect(result.structured.files).toEqual([
      {
        name: "PNADC_042024_20250815.zip",
        url: "https://ftp.ibge.gov.br/Trabalho_e_Rendimento/Pesquisa_Nacional_por_Amostra_de_Domicilios_continua/Trimestral/Microdados/2024/PNADC_042024_20250815.zip",
        kind: "file"
      }
    ]);
  });

  it("lists known POF microdata archive URLs without crawling large data files", async () => {
    const result = await listFilesTool({ survey: "pof" });
    expect(result.structured.files.some((file) => file.name === "POF 2017-2018 Dados")).toBe(true);
    expect(result.structured.files.some((file) => file.url.endsWith("Documentacao_20230713.zip"))).toBe(true);
  });
});

describe("listDirectoryTool", () => {
  it("lists any official IBGE download directory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response('<a href="Dados.zip">dados</a>', { status: 200 });
      })
    );

    const result = await listDirectoryTool({
      url: "https://ftp.ibge.gov.br/Some/Public/Microdados/"
    });
    expect(result.structured.files[0]).toEqual({
      name: "Dados.zip",
      url: "https://ftp.ibge.gov.br/Some/Public/Microdados/Dados.zip",
      kind: "file"
    });
  });
});

describe("discoverMicrodataTool", () => {
  it("wraps bounded official FTP microdata discovery", async () => {
    const pages: Record<string, string> = {
      "https://ftp.ibge.gov.br/root/": '<a href="Pesquisa_A/">Pesquisa A</a>',
      "https://ftp.ibge.gov.br/root/Pesquisa_A/": '<a href="Microdados/">Microdados</a>',
      "https://ftp.ibge.gov.br/root/Pesquisa_A/Microdados/": '<a href="Dados.zip">Dados</a>',
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(pages[url] ?? "", { status: pages[url] ? 200 : 404 }))
    );

    const result = await discoverMicrodataTool({
      rootUrl: "https://ftp.ibge.gov.br/root/",
      maxDepth: 3,
      maxDirectories: 10
    });

    expect(result.structured.matches.map((match) => match.name)).toEqual(["Microdados", "Dados.zip"]);
    expect(result.markdown).toContain("IBGE Microdata Discovery");
  });
});

describe("inspectLayoutTool", () => {
  it("lists variables from an official fixed-width input layout with optional search", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
@0018 VD4019  8.    /* Rendimento habitual */
`
    );

    const result = await inspectLayoutTool({
      layoutPath,
      search: "rendimento",
      limit: 10
    });

    expect(result.structured.totalVariables).toBe(3);
    expect(result.structured.variables).toEqual([
      {
        name: "VD4019",
        start: 18,
        width: 8,
        type: "number",
        description: "Rendimento habitual"
      }
    ]);
    expect(result.markdown).toContain("IBGE Fixed-Width Layout Variables");
  });
});

describe("remoteFileInfoTool", () => {
  it("returns HEAD metadata for a public IBGE file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "146294013", "content-type": "application/zip" }
        });
      })
    );

    const result = await remoteFileInfoTool({
      url: "https://ftp.ibge.gov.br/Orcamentos_Familiares/file.zip"
    });
    expect(result.structured.info.contentLength).toBe(146294013);
  });
});

describe("downloadFileTool", () => {
  it("downloads an official IBGE file into the requested local cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("abc", {
          status: 200,
          headers: { "content-length": "3", "content-type": "text/plain" }
        });
      })
    );

    const result = await downloadFileTool({
      cacheRoot: tempDir,
      url: "https://ftp.ibge.gov.br/path/file.txt"
    });

    expect(result.structured.path).toBe(path.join(tempDir, "ftp.ibge.gov.br/path/file.txt"));
    expect(result.structured.cacheStatus).toBe("miss");
    expect(result.markdown).toContain("Downloaded");
    expect(result.markdown).toContain("Cache status: miss");
  });
});

describe("listCachedFilesTool", () => {
  it("wraps local cache inventory for MCP-friendly output", async () => {
    const cachedPath = path.join(tempDir, "ftp.ibge.gov.br", "Some", "Survey", "Dados.zip");
    await mkdir(path.dirname(cachedPath), { recursive: true });
    await writeFile(cachedPath, "zip");

    const result = await listCachedFilesTool({
      cacheRoot: tempDir,
      limit: 10,
      offset: 0
    });

    expect(result.structured.total).toBe(1);
    expect(result.structured.files[0]).toMatchObject({
      url: "https://ftp.ibge.gov.br/Some/Survey/Dados.zip",
      bytes: 3
    });
    expect(result.markdown).toContain("IBGE Local Cache");
    expect(result.markdown).toContain("https://ftp.ibge.gov.br/Some/Survey/Dados.zip");
  });
});

describe("zip tools", () => {
  it("lists and extracts ZIP entries", async () => {
    const inputPath = path.join(tempDir, "input.txt");
    const zipPath = path.join(tempDir, "archive.zip");
    const outputPath = path.join(tempDir, "out", "input.txt");
    await writeFile(inputPath, "layout");
    await execFileAsync("zip", ["-j", zipPath, inputPath]);

    const listResult = await zipEntriesTool({ zipPath });
    expect(listResult.structured.entries[0].fileName).toBe("input.txt");

    const extractResult = await extractZipEntryTool({
      zipPath,
      entryName: "input.txt",
      outputPath
    });
    expect(extractResult.structured.outputPath).toBe(outputPath);
    expect(extractResult.markdown).toContain("Extracted");
  });
});

describe("pnadcAnalyzeFileTool", () => {
  it("wraps the PNAD text analyzer for MCP-friendly output", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    await writeFile(
      layoutPath,
      `
@0050 V1028   15.   /* Peso */
@0186 V4019   $1.   /* CNPJ */
@0417 VD4009   $2.   /* Posição */
@0444 VD4019   8.   /* Rendimento */
`
    );
    await writeFile(dataPath, [sampleLine("000000000000010", "1", " 8", "00010000")].join("\n"));

    const result = await pnadcAnalyzeFileTool({ layoutPath, dataPath, topPercents: [0.1] });
    expect(result.structured.summary.groups.employer_with_cnpj.weight).toBe(10);
    expect(result.markdown).toContain("employer_with_cnpj");
  });
});

describe("pnadcAnalyzeZipTool", () => {
  it("wraps direct PNAD ZIP-entry analysis for MCP-friendly output", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "PNADC_sample.txt");
    const zipPath = path.join(tempDir, "PNADC_sample.zip");
    await writeFile(
      layoutPath,
      `
@0050 V1028   15.   /* Peso */
@0186 V4019   $1.   /* CNPJ */
@0417 VD4009   $2.   /* Posição */
@0444 VD4019   8.   /* Rendimento */
`
    );
    await writeFile(dataPath, [sampleLine("000000000000010", "1", " 8", "00010000")].join("\n"));
    await execFileAsync("zip", ["-j", zipPath, dataPath]);

    const result = await pnadcAnalyzeZipTool({
      layoutPath,
      zipPath,
      entryName: "PNADC_sample.txt",
      topPercents: [0.1]
    });

    expect(result.structured.zipEntryName).toBe("PNADC_sample.txt");
    expect(result.structured.summary.groups.employer_with_cnpj.weight).toBe(10);
    expect(result.markdown).toContain("ZIP entry: PNADC_sample.txt");
  });
});

describe("fixed-width Parquet tools", () => {
  it("wraps fixed-width file to Parquet export for MCP-friendly output", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    const outputPath = path.join(tempDir, "sample.parquet");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
`
    );
    await writeFile(dataPath, "33000000000000080");

    const result = await fixedWidthFileToParquetTool({
      layoutPath,
      dataPath,
      outputPath,
      selectedVariables: ["UF", "V1028"]
    });

    expect(result.structured.rowsWritten).toBe(1);
    expect(result.structured.variables.map((variable) => variable.name)).toEqual(["UF", "V1028"]);
    expect(result.markdown).toContain("Exported IBGE Fixed-Width Microdata to Parquet");
  });

  it("wraps fixed-width ZIP entry to Parquet export for MCP-friendly output", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    const zipPath = path.join(tempDir, "sample.zip");
    const outputPath = path.join(tempDir, "sample-zip.parquet");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
`
    );
    await writeFile(dataPath, "33000000000000080");
    await execFileAsync("zip", ["-j", zipPath, dataPath]);

    const result = await fixedWidthZipToParquetTool({
      layoutPath,
      zipPath,
      entryName: "sample.txt",
      outputPath
    });

    expect(result.structured.sourceName).toBe("sample.txt");
    expect(result.structured.rowsWritten).toBe(1);
  });
});

describe("queryParquetTool", () => {
  it("wraps bounded DuckDB SQL over local Parquet files", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "sample.txt");
    const outputPath = path.join(tempDir, "sample.parquet");
    await writeFile(
      layoutPath,
      `
@0001 UF      $2.   /* Unidade da Federação */
@0003 V1028   15.   /* Peso */
`
    );
    await writeFile(dataPath, ["33000000000000080", "35000000000000010"].join("\n"));
    await fixedWidthFileToParquetTool({ layoutPath, dataPath, outputPath });

    const result = await queryParquetTool({
      parquetPaths: [outputPath],
      sql: "select UF, sum(V1028) as weight from microdata group by UF order by UF",
      maxRows: 10
    });

    expect(result.structured.rows).toEqual([
      { UF: "33", weight: 80 },
      { UF: "35", weight: 10 }
    ]);
    expect(result.markdown).toContain("Parquet Query Result");
  });
});

describe("queryParquetViewsTool", () => {
  it("wraps bounded DuckDB SQL joins over named Parquet views", async () => {
    const domicilioLayoutPath = path.join(tempDir, "domicilio-input.txt");
    const domicilioDataPath = path.join(tempDir, "domicilio.txt");
    const domicilioParquetPath = path.join(tempDir, "domicilio.parquet");
    const moradorLayoutPath = path.join(tempDir, "morador-input.txt");
    const moradorDataPath = path.join(tempDir, "morador.txt");
    const moradorParquetPath = path.join(tempDir, "morador.parquet");

    await writeFile(
      domicilioLayoutPath,
      `
@0001 COD_DOM $3.   /* Domicílio */
@0004 UF      $2.   /* Unidade da Federação */
`
    );
    await writeFile(domicilioDataPath, ["00133", "00235"].join("\n"));
    await fixedWidthFileToParquetTool({
      layoutPath: domicilioLayoutPath,
      dataPath: domicilioDataPath,
      outputPath: domicilioParquetPath
    });

    await writeFile(
      moradorLayoutPath,
      `
@0001 COD_DOM $3.   /* Domicílio */
@0004 RENDA   5.    /* Rendimento */
`
    );
    await writeFile(moradorDataPath, ["00101000", "00203000"].join("\n"));
    await fixedWidthFileToParquetTool({
      layoutPath: moradorLayoutPath,
      dataPath: moradorDataPath,
      outputPath: moradorParquetPath
    });

    const result = await queryParquetViewsTool({
      views: [
        { name: "domicilio", parquetPaths: [domicilioParquetPath] },
        { name: "morador", parquetPaths: [moradorParquetPath] }
      ],
      sql: "select d.UF, sum(m.RENDA) as income from domicilio d join morador m using (COD_DOM) group by d.UF order by d.UF",
      maxRows: 10
    });

    expect(result.structured.rows).toEqual([
      { UF: "33", income: 1000 },
      { UF: "35", income: 3000 }
    ]);
    expect(result.markdown).toContain("Parquet Views Query Result");
  });
});

describe("weightedDistributionTool", () => {
  it("wraps weighted top-share summaries over local Parquet views", async () => {
    const layoutPath = path.join(tempDir, "income-input.txt");
    const dataPath = path.join(tempDir, "income.txt");
    const outputPath = path.join(tempDir, "income.parquet");
    await writeFile(
      layoutPath,
      `
@0001 work_group $1.   /* Work group */
@0002 income     4.    /* Income */
@0006 weight     3.    /* Weight */
`
    );
    await writeFile(dataPath, ["E0100050", "E0200020", "B1000010", "B0000020"].join("\n"));
    await fixedWidthFileToParquetTool({
      layoutPath,
      dataPath,
      outputPath
    });

    const result = await weightedDistributionTool({
      views: [{ name: "microdata", parquetPaths: [outputPath] }],
      unitSql: "select work_group, income, weight from microdata",
      valueColumn: "income",
      weightColumn: "weight",
      groupColumn: "work_group",
      topPercents: [0.1]
    });

    expect(result.structured.totalWeight).toBe(100);
    expect(result.structured.totalValue).toBe(19000);
    expect(result.structured.topBrackets[0].percent).toBe(0.1);
    expect(result.structured.topBrackets[0].valueShare).toBe(10000 / 19000);
    expect(result.markdown).toContain("Weighted Distribution Summary");
    expect(result.markdown).toContain("Top 10%");
  });
});

describe("describeParquetViewsTool", () => {
  it("wraps schema inspection for named Parquet views", async () => {
    const layoutPath = path.join(tempDir, "domicilio-input.txt");
    const dataPath = path.join(tempDir, "domicilio.txt");
    const outputPath = path.join(tempDir, "domicilio.parquet");
    await writeFile(
      layoutPath,
      `
@0001 COD_DOM $3.   /* Domicílio */
@0004 UF      $2.   /* Unidade da Federação */
`
    );
    await writeFile(dataPath, ["00133", "00235"].join("\n"));
    await fixedWidthFileToParquetTool({ layoutPath, dataPath, outputPath });

    const result = await describeParquetViewsTool({
      views: [{ name: "domicilio", parquetPaths: [outputPath] }],
      includeRowCounts: true,
      sampleRows: 1
    });

    expect(result.structured.views[0].columns.map((column) => column.name)).toEqual(["COD_DOM", "UF"]);
    expect(result.structured.views[0].rowCount).toBe(2);
    expect(result.structured.views[0].sampleRows).toEqual([{ COD_DOM: "001", UF: "33" }]);
    expect(result.markdown).toContain("Parquet View Schema");
  });
});

describe("profileParquetViewsTool", () => {
  it("wraps bounded Parquet profiling for MCP-friendly output", async () => {
    const layoutPath = path.join(tempDir, "profile-input.txt");
    const dataPath = path.join(tempDir, "profile.txt");
    const outputPath = path.join(tempDir, "profile.parquet");
    await writeFile(
      layoutPath,
      `
@0001 region        $2.   /* Region */
@0003 target_value  4.    /* Target value */
@0007 sample_weight 3.    /* Sample weight */
`
    );
    await writeFile(dataPath, ["330100002", "330200003", "35    005"].join("\n"));
    await fixedWidthFileToParquetTool({ layoutPath, dataPath, outputPath });

    const result = await profileParquetViewsTool({
      views: [{ name: "microdata", parquetPaths: [outputPath] }],
      columns: ["region", "target_value"],
      topK: 2,
      sampleRows: 1
    });

    expect(result.structured.views[0].rowCount).toBe(3);
    expect(result.structured.views[0].columns.map((column) => column.name)).toEqual(["region", "target_value"]);
    expect(result.structured.views[0].columns[1].numeric).toEqual({
      min: 100,
      max: 200,
      mean: 150
    });
    expect(result.markdown).toContain("Parquet View Profile");
    expect(result.markdown).toContain("target_value");
  });
});

describe("POF tools", () => {
  it("wraps POF dictionary manifest parsing", async () => {
    const dictionaryPath = path.join(tempDir, "Dicionarios.xls");
    createPofDictionary(dictionaryPath);

    const result = await pofDictionaryManifestTool({
      dictionaryPath,
      search: "expansão",
      variableLimit: 5
    });

    expect(result.structured.records[0].variables.map((variable) => variable.name)).toEqual(["V1028"]);
    expect(result.markdown).toContain("POF Dictionary Manifest");
  });

  it("wraps POF ZIP-record conversion to Parquet", async () => {
    const dictionaryPath = path.join(tempDir, "Dicionarios.xls");
    const dataPath = path.join(tempDir, "DOMICILIO.txt");
    const dataZipPath = path.join(tempDir, "Dados.zip");
    const outputPath = path.join(tempDir, "domicilio.parquet");
    createPofDictionary(dictionaryPath);
    await writeFile(dataPath, "33000000000000080");
    await execFileAsync("zip", ["-j", dataZipPath, dataPath]);

    const result = await pofZipRecordToParquetTool({
      dictionaryPath,
      zipPath: dataZipPath,
      recordName: "Domicílio",
      outputPath,
      selectedVariables: ["UF", "V1028"]
    });

    expect(result.structured.sourceName).toBe("DOMICILIO.txt");
    expect(result.structured.rowsWritten).toBe(1);
  });
});

function sampleLine(weight: string, cnpj: string, group: string, income: string): string {
  const chars = Array.from({ length: 451 }, () => " ");
  chars.splice(49, 15, ...weight);
  chars.splice(185, 1, ...cnpj);
  chars.splice(416, 2, ...group);
  chars.splice(443, 8, ...income);
  return chars.join("");
}

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
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "Domicílio");
  XLSX.writeFile(wb, dictionaryPath);
}
