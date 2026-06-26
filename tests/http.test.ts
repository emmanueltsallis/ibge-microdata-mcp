import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachePathForUrl,
  checkIbgeConnectivity,
  downloadRemoteFile,
  fetchDirectoryEntries,
  getRemoteFileInfo
} from "../src/http.js";
import { metadataPathForDataPath } from "../src/cache-metadata.js";

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
      resolvedUrl: "https://ftp.ibge.gov.br/path/file.zip",
      transport: "https",
      usedFallback: false,
      contentLength: 209873314,
      contentType: "application/zip",
      lastModified: "Fri, 15 Aug 2025 13:23:58 GMT",
      etag: '"c8269a2-63c674d6aee8c"'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ftp.ibge.gov.br/path/file.zip",
      expect.objectContaining({ method: "HEAD" })
    );
  });

  it("falls back to official HTTP when HTTPS metadata fetch fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://")) {
        throw new Error("Connect Timeout Error");
      }

      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "146294013",
          "content-type": "application/zip"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRemoteFileInfo("https://ftp.ibge.gov.br/path/file.zip")).resolves.toMatchObject({
      url: "https://ftp.ibge.gov.br/path/file.zip",
      resolvedUrl: "http://ftp.ibge.gov.br/path/file.zip",
      transport: "http",
      usedFallback: true,
      contentLength: 146294013
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts explicit official HTTP URLs", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "10",
          "content-type": "text/plain"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRemoteFileInfo("http://ftp.ibge.gov.br/path/file.txt")).resolves.toMatchObject({
      url: "http://ftp.ibge.gov.br/path/file.txt",
      resolvedUrl: "http://ftp.ibge.gov.br/path/file.txt",
      transport: "http",
      usedFallback: false,
      contentLength: 10
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(result.transport).toBe("https");
    expect(result.usedFallback).toBe(false);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.path).toBe(path.join(tempDir, "ftp.ibge.gov.br/path/file.txt"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(readFile(result.path, "utf8")).resolves.toBe("microdata");

    const metadata = JSON.parse(await readFile(metadataPathForDataPath(result.path), "utf8")) as {
      sha256: string;
      sourceUrl: string;
    };
    expect(metadata.sha256).toBe(result.sha256);
    expect(metadata.sourceUrl).toBe("https://ftp.ibge.gov.br/path/file.txt");
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
    expect(result.resolvedUrl).toBe("https://ftp.ibge.gov.br/path/file.txt");
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

  it("uses the resolved HTTP fallback URL for the body download", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD" && url.startsWith("https://")) {
        throw new Error("Connect Timeout Error");
      }
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "3", "content-type": "text/plain" }
        });
      }

      expect(url).toBe("http://ftp.ibge.gov.br/path/file.txt");
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

    expect(result.transport).toBe("http");
    expect(result.usedFallback).toBe(true);
    expect(result.resolvedUrl).toBe("http://ftp.ibge.gov.br/path/file.txt");
    await expect(readFile(result.path, "utf8")).resolves.toBe("new");
  });
});

describe("checkIbgeConnectivity", () => {
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("reports endpoint status and overall FTP availability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://ftp.ibge.gov.br/") {
          throw new Error("Connect Timeout Error");
        }

        return new Response("ok", { status: 200, statusText: "OK" });
      })
    );

    const result = await checkIbgeConnectivity({ timeoutMs: 1000 });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.url === "https://ftp.ibge.gov.br/")).toMatchObject({
      ok: false,
      error: "Connect Timeout Error"
    });
    expect(result.checks.find((check) => check.url === "http://ftp.ibge.gov.br/")).toMatchObject({
      ok: true,
      status: 200
    });
  });
});
