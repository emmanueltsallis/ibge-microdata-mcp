import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listCachedFiles } from "../src/cache.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-cache-list-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("listCachedFiles", () => {
  it("returns an empty paginated result when the cache root does not exist", async () => {
    const result = await listCachedFiles({
      cacheRoot: path.join(tempDir, "missing"),
      limit: 20,
      offset: 0
    });

    expect(result).toEqual({
      cacheRoot: path.join(tempDir, "missing"),
      total: 0,
      count: 0,
      offset: 0,
      hasMore: false,
      files: []
    });
  });

  it("lists cached official IBGE files with reconstructed source URLs", async () => {
    await writeCachedFile("Trabalho_e_Rendimento/Sample/A.zip", "zip");
    await writeCachedFile("Orcamentos_Familiares/Sample/B.txt", "txt-data");
    await writeFile(path.join(tempDir, "notes.txt"), "ignored");

    const result = await listCachedFiles({
      cacheRoot: tempDir,
      limit: 10,
      offset: 0
    });

    expect(result.total).toBe(2);
    expect(result.count).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.files.map((file) => file.relativePath)).toEqual([
      "ftp.ibge.gov.br/Orcamentos_Familiares/Sample/B.txt",
      "ftp.ibge.gov.br/Trabalho_e_Rendimento/Sample/A.zip"
    ]);
    expect(result.files[0]).toMatchObject({
      url: "https://ftp.ibge.gov.br/Orcamentos_Familiares/Sample/B.txt",
      bytes: 8
    });
    expect(result.files[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("paginates cached file listings with next offsets", async () => {
    await writeCachedFile("A/one.zip", "1");
    await writeCachedFile("B/two.zip", "22");
    await writeCachedFile("C/three.zip", "333");

    const result = await listCachedFiles({
      cacheRoot: tempDir,
      limit: 2,
      offset: 1
    });

    expect(result.total).toBe(3);
    expect(result.count).toBe(2);
    expect(result.offset).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeUndefined();
    expect(result.files.map((file) => file.url)).toEqual([
      "https://ftp.ibge.gov.br/B/two.zip",
      "https://ftp.ibge.gov.br/C/three.zip"
    ]);
  });
});

async function writeCachedFile(relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(tempDir, "ftp.ibge.gov.br", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}
