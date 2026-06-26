import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupCachedFiles, listCachedFiles } from "../src/cache.js";

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

describe("cleanupCachedFiles", () => {
  it("previews matching cached files without deleting them by default", async () => {
    const oldLargePath = await writeCachedFile("A/old-large.zip", "old-large-file");
    const recentLargePath = await writeCachedFile("A/recent-large.zip", "recent-large-file");
    const oldSmallPath = await writeCachedFile("A/old-small.txt", "old");
    await setModifiedDaysAgo(oldLargePath, 45);
    await setModifiedDaysAgo(oldSmallPath, 45);

    const result = await cleanupCachedFiles({
      cacheRoot: tempDir,
      olderThanDays: 30,
      minBytes: 10,
      dryRun: true
    });

    expect(result).toMatchObject({
      cacheRoot: tempDir,
      dryRun: true,
      matchedCount: 1,
      deletedCount: 0,
      matchedBytes: 14,
      deletedBytes: 0
    });
    expect(result.files.map((file) => file.relativePath)).toEqual(["ftp.ibge.gov.br/A/old-large.zip"]);
    await expect(stat(oldLargePath)).resolves.toBeDefined();
    await expect(stat(recentLargePath)).resolves.toBeDefined();
    await expect(stat(oldSmallPath)).resolves.toBeDefined();
  });

  it("deletes only matching cached files when dryRun is false", async () => {
    const keepPath = await writeCachedFile("A/keep.zip", "keep-this-file");
    const deletePath = await writeCachedFile("Orcamentos_Familiares/delete.zip", "delete-this-file");
    await setModifiedDaysAgo(keepPath, 60);
    await setModifiedDaysAgo(deletePath, 60);

    const result = await cleanupCachedFiles({
      cacheRoot: tempDir,
      olderThanDays: 30,
      urlPrefix: "https://ftp.ibge.gov.br/Orcamentos_Familiares/",
      dryRun: false
    });

    expect(result.dryRun).toBe(false);
    expect(result.matchedCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(result.files).toEqual([
      expect.objectContaining({
        relativePath: "ftp.ibge.gov.br/Orcamentos_Familiares/delete.zip",
        deleted: true
      })
    ]);
    await expect(stat(keepPath)).resolves.toBeDefined();
    await expect(stat(deletePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires at least one cleanup filter", async () => {
    await expect(
      cleanupCachedFiles({
        cacheRoot: tempDir,
        dryRun: true
      })
    ).rejects.toThrow("At least one cleanup filter is required");
  });

  it("rejects cache roots that point directly at the mirrored IBGE host directory", async () => {
    await expect(
      cleanupCachedFiles({
        cacheRoot: path.join(tempDir, "ftp.ibge.gov.br"),
        olderThanDays: 1,
        dryRun: true
      })
    ).rejects.toThrow("cacheRoot must be the parent directory that contains ftp.ibge.gov.br");
  });
});

async function writeCachedFile(relativePath: string, contents: string): Promise<string> {
  const filePath = path.join(tempDir, "ftp.ibge.gov.br", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

async function setModifiedDaysAgo(filePath: string, daysAgo: number): Promise<void> {
  const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await utimes(filePath, timestamp, timestamp);
}
