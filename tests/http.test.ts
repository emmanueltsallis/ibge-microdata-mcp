import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachePathForUrl,
  downloadRemoteFile,
  fetchDirectoryEntries,
  getRemoteFileInfo
} from "../src/http.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-http-"));
});

describe("getRemoteFileInfo", () => {
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("uses HEAD and returns file size and validators without downloading the body", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "209873314",
          "last-modified": "Fri, 15 Aug 2025 13:23:58 GMT",
          etag: '"c8269a2-63c674d6aee8c"',
          "content-type": "application/zip"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRemoteFileInfo("https://ftp.ibge.gov.br/path/file.zip")).resolves.toEqual({
      url: "https://ftp.ibge.gov.br/path/file.zip",
      contentLength: 209873314,
      contentType: "application/zip",
      lastModified: "Fri, 15 Aug 2025 13:23:58 GMT",
      etag: '"c8269a2-63c674d6aee8c"'
    });
    expect(fetchMock).toHaveBeenCalledWith("https://ftp.ibge.gov.br/path/file.zip", { method: "HEAD" });
  });
});

describe("fetchDirectoryEntries", () => {
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("fetches an IBGE HTML directory and parses its downloadable entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response('<a href="PNADC_012024_20250815.zip">file</a>', { status: 200 });
      })
    );

    await expect(fetchDirectoryEntries("https://ftp.ibge.gov.br/base/")).resolves.toEqual([
      {
        name: "PNADC_012024_20250815.zip",
        url: "https://ftp.ibge.gov.br/base/PNADC_012024_20250815.zip",
        kind: "file"
      }
    ]);
  });
});

describe("cachePathForUrl", () => {
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("maps official IBGE URLs under the configured cache root", () => {
    expect(
      cachePathForUrl(
        "/tmp/ibge-cache",
        "https://ftp.ibge.gov.br/Orcamentos_Familiares/Pesquisa/Microdados/Dados.zip"
      )
    ).toBe("/tmp/ibge-cache/ftp.ibge.gov.br/Orcamentos_Familiares/Pesquisa/Microdados/Dados.zip");
  });

  it("rejects non-IBGE hosts", () => {
    expect(() => cachePathForUrl("/tmp/ibge-cache", "https://example.com/file.zip")).toThrow(
      "Only ftp.ibge.gov.br URLs can be cached"
    );
  });
});

describe("downloadRemoteFile", () => {
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("streams an uncached official IBGE URL into the local cache", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "9", "content-type": "text/plain" }
        });
      }

      return new Response("microdata", {
        status: 200,
        headers: { "content-length": "9", "content-type": "text/plain" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadRemoteFile({
      cacheRoot: tempDir,
      url: "https://ftp.ibge.gov.br/path/file.txt"
    });

    expect(result.cacheStatus).toBe("miss");
    expect(result.bytesWritten).toBe(9);
    expect(result.path).toBe(path.join(tempDir, "ftp.ibge.gov.br/path/file.txt"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(readFile(result.path, "utf8")).resolves.toBe("microdata");
  });

  it("reuses a cached file when its byte size matches the official content length", async () => {
    const cachedPath = cachePathForUrl(tempDir, "https://ftp.ibge.gov.br/path/file.txt");
    await mkdir(path.dirname(cachedPath), { recursive: true });
    await writeFile(cachedPath, "abc");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "3", "content-type": "text/plain" }
        });
      }

      throw new Error("cache hit should not download the file body");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadRemoteFile({
      cacheRoot: tempDir,
      url: "https://ftp.ibge.gov.br/path/file.txt"
    });

    expect(result.cacheStatus).toBe("hit");
    expect(result.bytesWritten).toBe(3);
    expect(result.contentType).toBe("text/plain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(readFile(result.path, "utf8")).resolves.toBe("abc");
  });

  it("refreshes a cached file when its byte size does not match the official content length", async () => {
    const cachedPath = cachePathForUrl(tempDir, "https://ftp.ibge.gov.br/path/file.txt");
    await mkdir(path.dirname(cachedPath), { recursive: true });
    await writeFile(cachedPath, "stale");

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "3", "content-type": "text/plain" }
        });
      }

      return new Response("new", {
        status: 200,
        headers: { "content-length": "3", "content-type": "text/plain" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadRemoteFile({
      cacheRoot: tempDir,
      url: "https://ftp.ibge.gov.br/path/file.txt"
    });

    expect(result.cacheStatus).toBe("refreshed");
    expect(result.bytesWritten).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(readFile(result.path, "utf8")).resolves.toBe("new");
  });
});
