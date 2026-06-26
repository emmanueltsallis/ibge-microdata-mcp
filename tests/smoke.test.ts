import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listCachedFiles } from "../src/cache.js";
import { PNADC_TRIMESTRAL_MICRODATA_URL, POF_MICRODATA_URL } from "../src/catalog.js";
import { discoverMicrodataFiles } from "../src/discovery.js";
import { fetchDirectoryEntries, getRemoteFileInfo, downloadRemoteFile } from "../src/http.js";
import { buildMetadataInventory } from "../src/metadata.js";
import { readPofDictionaryManifest } from "../src/pof.js";
import { extractZipEntry, listZipEntries } from "../src/zip.js";

const maybeDescribe = process.env.RUN_IBGE_SMOKE === "1" ? describe : describe.skip;
let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

maybeDescribe("official IBGE smoke tests", () => {
  it("finds current PNAD Contínua quarterly microdata ZIPs in an official year directory", async () => {
    const entries = await fetchDirectoryEntries(`${PNADC_TRIMESTRAL_MICRODATA_URL}2024/`);
    expect(entries.some((entry) => entry.name.startsWith("PNADC_042024_") && entry.name.endsWith(".zip"))).toBe(
      true
    );
  });

  it("reads POF 2017-2018 data ZIP metadata without downloading the file", async () => {
    const info = await getRemoteFileInfo(
      "https://ftp.ibge.gov.br/Orcamentos_Familiares/Pesquisa_de_Orcamentos_Familiares_2017_2018/Microdados/Dados_20230713.zip"
    );
    expect(info.contentLength ?? 0).toBeGreaterThan(100_000_000);
    expect(info.contentType).toContain("zip");
  });

  it("finds public POF edition directories in the official POF download directory", async () => {
    const entries = await fetchDirectoryEntries(POF_MICRODATA_URL);
    expect(entries.some((entry) => entry.name === "Pesquisa_de_Orcamentos_Familiares_2017_2018")).toBe(true);
  });

  it("discovers the POF 2017-2018 microdata directory with a bounded crawl", async () => {
    const result = await discoverMicrodataFiles({
      rootUrl: `${POF_MICRODATA_URL}Pesquisa_de_Orcamentos_Familiares_2017_2018/`,
      maxDepth: 1,
      maxDirectories: 5,
    });
    expect(result.matches.some((match) => match.name === "Microdados" && match.kind === "directory")).toBe(true);
  });

  it("parses the official POF 2017-2018 dictionary workbook from the documentation ZIP", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-pof-smoke-"));
    const downloaded = await downloadRemoteFile({
      cacheRoot: tempDir,
      url: "https://ftp.ibge.gov.br/Orcamentos_Familiares/Pesquisa_de_Orcamentos_Familiares_2017_2018/Microdados/Documentacao_20230713.zip",
    });
    expect(downloaded.cacheStatus).toBe("miss");
    const cached = await downloadRemoteFile({
      cacheRoot: tempDir,
      url: "https://ftp.ibge.gov.br/Orcamentos_Familiares/Pesquisa_de_Orcamentos_Familiares_2017_2018/Microdados/Documentacao_20230713.zip",
    });
    expect(cached.cacheStatus).toBe("hit");
    expect(cached.path).toBe(downloaded.path);
    const cacheInventory = await listCachedFiles({ cacheRoot: tempDir });
    expect(cacheInventory.files.some((file) => file.url === downloaded.url && file.path === downloaded.path)).toBe(true);

    const entries = await listZipEntries(downloaded.path);
    const dictionaryEntry = entries.find((entry) => entry.fileName.includes("Dicion"));
    expect(dictionaryEntry).toBeDefined();

    const dictionaryPath = path.join(tempDir, "pof-dictionary.xls");
    await extractZipEntry(downloaded.path, dictionaryEntry!.fileName, dictionaryPath);
    const manifest = await readPofDictionaryManifest({ dictionaryPath, variableLimit: 1 });

    expect(manifest.recordCount).toBe(16);
    expect(manifest.records.some((record) => record.sheetName === "Domicílio" && record.dataEntryName === "DOMICILIO.txt")).toBe(
      true
    );

    const inventory = await buildMetadataInventory({ zipPaths: [downloaded.path], variableLimit: 1 });
    expect(inventory.parsedSources).toBeGreaterThan(0);
    expect(inventory.records.some((record) => record.recordName === "Domicílio")).toBe(true);
  });
});
