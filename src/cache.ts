import path from "node:path";
import { readdir, stat } from "node:fs/promises";

export interface ListCachedFilesInput {
  cacheRoot: string;
  limit?: number;
  offset?: number;
}

export interface CachedFileInfo {
  path: string;
  relativePath: string;
  url: string;
  bytes: number;
  modifiedAt: string;
}

export interface ListCachedFilesOutput {
  cacheRoot: string;
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  files: CachedFileInfo[];
}

const CACHE_HOST = "ftp.ibge.gov.br";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export async function listCachedFiles(input: ListCachedFilesInput): Promise<ListCachedFilesOutput> {
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);
  const hostRoot = path.join(input.cacheRoot, CACHE_HOST);

  if (!(await isDirectory(hostRoot))) {
    return {
      cacheRoot: input.cacheRoot,
      total: 0,
      count: 0,
      offset,
      hasMore: false,
      files: [],
    };
  }

  const files = await walkCachedFiles(input.cacheRoot, hostRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const pagedFiles = files.slice(offset, offset + limit);
  const nextOffset = offset + pagedFiles.length;
  const hasMore = nextOffset < files.length;

  return {
    cacheRoot: input.cacheRoot,
    total: files.length,
    count: pagedFiles.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    files: pagedFiles,
  };
}

async function walkCachedFiles(cacheRoot: string, directoryPath: string): Promise<CachedFileInfo[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: CachedFileInfo[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkCachedFiles(cacheRoot, entryPath)));
      continue;
    }
    if (!entry.isFile()) continue;

    const stats = await stat(entryPath);
    const relativePath = path.relative(cacheRoot, entryPath).split(path.sep).join("/");
    const urlPath = relativePath.slice(`${CACHE_HOST}/`.length);
    files.push({
      path: entryPath,
      relativePath,
      url: `https://${CACHE_HOST}/${urlPath}`,
      bytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return files;
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stats = await stat(directoryPath);
    return stats.isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  return offset;
}
