import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { extractDirectoryEntries, type DirectoryEntry } from "./catalog.js";
import { metadataPathForDataPath, type IbgeCacheMetadata } from "./cache-metadata.js";

export interface RemoteFileInfo {
  url: string;
  resolvedUrl: string;
  transport: IbgeTransport;
  usedFallback: boolean;
  contentLength: number | null;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
}

export interface DownloadRemoteFileInput {
  url: string;
  cacheRoot: string;
}

export interface DownloadRemoteFileOutput {
  url: string;
  resolvedUrl: string;
  transport: IbgeTransport;
  usedFallback: boolean;
  path: string;
  bytesWritten: number;
  sha256?: string;
  contentType: string | null;
  cacheStatus: "hit" | "miss" | "refreshed";
}

export type IbgeTransport = "https" | "http";

export interface IbgeConnectivityInput {
  timeoutMs?: number;
}

export interface IbgeConnectivityCheck {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  statusText: string | null;
  durationMs: number;
  error: string | null;
}

export interface IbgeConnectivityOutput {
  ok: boolean;
  timeoutMs: number;
  checks: IbgeConnectivityCheck[];
}

interface OfficialIbgeFetchResult {
  response: Response;
  resolvedUrl: string;
  transport: IbgeTransport;
  usedFallback: boolean;
}

const DEFAULT_METADATA_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECTIVITY_TIMEOUT_MS = 8_000;

export async function getRemoteFileInfo(url: string): Promise<RemoteFileInfo> {
  const fetchResult = await fetchOfficialIbge(url, {
    init: { method: "HEAD" },
    timeoutMs: DEFAULT_METADATA_TIMEOUT_MS,
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`IBGE file metadata request failed with HTTP ${response.status}`);
  }

  const length = response.headers.get("content-length");
  return {
    url,
    resolvedUrl: fetchResult.resolvedUrl,
    transport: fetchResult.transport,
    usedFallback: fetchResult.usedFallback,
    contentLength: length === null ? null : Number.parseInt(length, 10),
    contentType: response.headers.get("content-type"),
    lastModified: response.headers.get("last-modified"),
    etag: response.headers.get("etag"),
  };
}

export async function fetchDirectoryEntries(url: string): Promise<DirectoryEntry[]> {
  const { response } = await fetchOfficialIbge(url, { timeoutMs: DEFAULT_METADATA_TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`IBGE directory request failed with HTTP ${response.status}`);
  }
  return extractDirectoryEntries(await response.text(), url);
}

export function cachePathForUrl(cacheRoot: string, url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "ftp.ibge.gov.br") {
    throw new Error("Only ftp.ibge.gov.br URLs can be cached");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http:// or https:// ftp.ibge.gov.br URLs can be cached");
  }

  const parts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => sanitizePathSegment(decodeURIComponent(part)));

  return path.join(cacheRoot, parsed.hostname, ...parts);
}

export async function downloadRemoteFile(
  input: DownloadRemoteFileInput
): Promise<DownloadRemoteFileOutput> {
  const outputPath = cachePathForUrl(input.cacheRoot, input.url);
  const remoteInfo = await getRemoteFileInfo(input.url);
  const existingSize = await getExistingFileSize(outputPath);

  if (
    remoteInfo.contentLength !== null &&
    existingSize !== null &&
    existingSize === remoteInfo.contentLength
  ) {
    return {
      url: input.url,
      resolvedUrl: remoteInfo.resolvedUrl,
      transport: remoteInfo.transport,
      usedFallback: remoteInfo.usedFallback,
      path: outputPath,
      bytesWritten: existingSize,
      contentType: remoteInfo.contentType,
      cacheStatus: "hit",
    };
  }

  const cacheStatus = existingSize === null ? "miss" : "refreshed";
  const response = await fetch(remoteInfo.resolvedUrl);
  if (!response.ok) {
    throw new Error(`IBGE file download failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("IBGE file download returned an empty body");
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const nodeReadable = Readable.fromWeb(
    response.body as unknown as Parameters<typeof Readable.fromWeb>[0]
  );
  await pipeline(nodeReadable, createWriteStream(outputPath));

  const writtenSize = await getExistingFileSize(outputPath);
  const sha256 = await sha256File(outputPath);
  await writeDownloadMetadata(outputPath, {
    sourceUrl: input.url,
    resolvedUrl: remoteInfo.resolvedUrl,
    transport: remoteInfo.transport,
    usedFallback: remoteInfo.usedFallback,
    contentLength: remoteInfo.contentLength,
    contentType: response.headers.get("content-type") ?? remoteInfo.contentType,
    lastModified: remoteInfo.lastModified,
    etag: remoteInfo.etag,
    bytesWritten: writtenSize ?? 0,
    sha256,
    downloadedAt: new Date().toISOString(),
  });

  return {
    url: input.url,
    resolvedUrl: remoteInfo.resolvedUrl,
    transport: remoteInfo.transport,
    usedFallback: remoteInfo.usedFallback,
    path: outputPath,
    bytesWritten: writtenSize ?? 0,
    sha256,
    contentType: response.headers.get("content-type") ?? remoteInfo.contentType,
    cacheStatus,
  };
}

export async function checkIbgeConnectivity(
  input: IbgeConnectivityInput = {}
): Promise<IbgeConnectivityOutput> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_CONNECTIVITY_TIMEOUT_MS;
  const checks = await Promise.all([
    runConnectivityCheck("IBGE FTP over HTTPS", "https://ftp.ibge.gov.br/", timeoutMs),
    runConnectivityCheck("IBGE FTP over HTTP", "http://ftp.ibge.gov.br/", timeoutMs),
    runConnectivityCheck("IBGE website", "https://www.ibge.gov.br/", timeoutMs),
    runConnectivityCheck(
      "IBGE localidades API",
      "https://servicodados.ibge.gov.br/api/v1/localidades/estados",
      timeoutMs
    ),
  ]);

  return {
    ok: checks.some((check) => check.name === "IBGE FTP over HTTPS" && check.ok) ||
      checks.some((check) => check.name === "IBGE FTP over HTTP" && check.ok),
    timeoutMs,
    checks,
  };
}

async function fetchOfficialIbge(
  url: string,
  options: { init?: RequestInit; timeoutMs?: number } = {}
): Promise<OfficialIbgeFetchResult> {
  const candidates = officialIbgeUrlCandidates(url);
  const errors: string[] = [];

  for (const [index, candidate] of candidates.entries()) {
    try {
      const response = await fetchWithTimeout(candidate, options.init, options.timeoutMs);
      return {
        response,
        resolvedUrl: candidate,
        transport: new URL(candidate).protocol === "https:" ? "https" : "http",
        usedFallback: index > 0,
      };
    } catch (error) {
      errors.push(`${candidate}: ${errorMessage(error)}`);
    }
  }

  throw new Error(`IBGE request failed for all allowed transports. ${errors.join(" | ")}`);
}

function officialIbgeUrlCandidates(url: string): string[] {
  const parsed = new URL(url);
  if (parsed.hostname !== "ftp.ibge.gov.br") {
    throw new Error("Only ftp.ibge.gov.br URLs are supported");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http:// or https:// ftp.ibge.gov.br URLs are supported");
  }
  if (parsed.protocol === "http:") {
    return [parsed.toString()];
  }

  const fallback = new URL(parsed.toString());
  fallback.protocol = "http:";
  return [parsed.toString(), fallback.toString()];
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number | undefined
): Promise<Response> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return fetch(url, init);
  }

  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function runConnectivityCheck(
  name: string,
  url: string,
  timeoutMs: number
): Promise<IbgeConnectivityCheck> {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    await response.body?.cancel();
    return {
      name,
      url,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      status: null,
      statusText: null,
      durationMs: Date.now() - started,
      error: errorMessage(error),
    };
  }
}

async function getExistingFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats.size : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sanitizePathSegment(segment: string): string {
  if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new Error(`Unsafe path segment in IBGE URL: ${segment}`);
  }
  return segment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function writeDownloadMetadata(filePath: string, metadata: IbgeCacheMetadata): Promise<void> {
  await writeFile(metadataPathForDataPath(filePath), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}
