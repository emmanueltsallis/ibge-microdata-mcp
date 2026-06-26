import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { extractDirectoryEntries, type DirectoryEntry } from "./catalog.js";

export interface RemoteFileInfo {
  url: string;
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
  path: string;
  bytesWritten: number;
  contentType: string | null;
  cacheStatus: "hit" | "miss" | "refreshed";
}

export async function getRemoteFileInfo(url: string): Promise<RemoteFileInfo> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`IBGE file metadata request failed with HTTP ${response.status}`);
  }

  const length = response.headers.get("content-length");
  return {
    url,
    contentLength: length === null ? null : Number.parseInt(length, 10),
    contentType: response.headers.get("content-type"),
    lastModified: response.headers.get("last-modified"),
    etag: response.headers.get("etag"),
  };
}

export async function fetchDirectoryEntries(url: string): Promise<DirectoryEntry[]> {
  const response = await fetch(url);
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
      path: outputPath,
      bytesWritten: existingSize,
      contentType: remoteInfo.contentType,
      cacheStatus: "hit",
    };
  }

  const cacheStatus = existingSize === null ? "miss" : "refreshed";
  const response = await fetch(input.url);
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
  return {
    url: input.url,
    path: outputPath,
    bytesWritten: writtenSize ?? 0,
    contentType: response.headers.get("content-type") ?? remoteInfo.contentType,
    cacheStatus,
  };
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
