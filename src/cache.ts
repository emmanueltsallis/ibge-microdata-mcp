import path from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";

export interface ListCachedFilesInput {
  cacheRoot: string;
  limit?: number;
  offset?: number;
}

export interface CleanupCachedFilesInput {
  cacheRoot: string;
  dryRun?: boolean;
  olderThanDays?: number;
  minBytes?: number;
  urlPrefix?: string;
}

export interface CachedFileInfo {
  path: string;
  relativePath: string;
  url: string;
  bytes: number;
  modifiedAt: string;
}

export interface CleanupCachedFileInfo extends CachedFileInfo {
  deleted: boolean;
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

export interface CleanupCachedFilesOutput {
  cacheRoot: string;
  dryRun: boolean;
  matchedCount: number;
  deletedCount: number;
  matchedBytes: number;
  deletedBytes: number;
  files: CleanupCachedFileInfo[];
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

export async function cleanupCachedFiles(input: CleanupCachedFilesInput): Promise<CleanupCachedFilesOutput> {
  const dryRun = input.dryRun ?? true;
  const filters = normalizeCleanupFilters(input);
  const hostRoot = path.join(input.cacheRoot, CACHE_HOST);

  if (path.basename(path.resolve(input.cacheRoot)) === CACHE_HOST) {
    throw new Error("cacheRoot must be the parent directory that contains ftp.ibge.gov.br");
  }

  if (!(await isDirectory(hostRoot))) {
    return {
      cacheRoot: input.cacheRoot,
      dryRun,
      matchedCount: 0,
      deletedCount: 0,
      matchedBytes: 0,
      deletedBytes: 0,
      files: [],
    };
  }

  const files = await walkCachedFiles(input.cacheRoot, hostRoot);
  const matchedFiles = files
    .filter((file) => matchesCleanupFilters(file, filters))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const cleanedFiles: CleanupCachedFileInfo[] = [];
  let deletedCount = 0;
  let deletedBytes = 0;

  for (const file of matchedFiles) {
    const deleted = !dryRun;
    if (deleted) {
      await unlink(file.path);
      deletedCount += 1;
      deletedBytes += file.bytes;
    }
    cleanedFiles.push({ ...file, deleted });
  }

  return {
    cacheRoot: input.cacheRoot,
    dryRun,
    matchedCount: matchedFiles.length,
    deletedCount,
    matchedBytes: matchedFiles.reduce((total, file) => total + file.bytes, 0),
    deletedBytes,
    files: cleanedFiles,
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

interface CleanupFilters {
  olderThanMs?: number;
  minBytes?: number;
  urlPrefix?: string;
}

function normalizeCleanupFilters(input: CleanupCachedFilesInput): CleanupFilters {
  if (input.olderThanDays === undefined && input.minBytes === undefined && input.urlPrefix === undefined) {
    throw new Error("At least one cleanup filter is required");
  }

  const filters: CleanupFilters = {};
  if (input.olderThanDays !== undefined) {
    if (!Number.isInteger(input.olderThanDays) || input.olderThanDays < 0) {
      throw new Error("olderThanDays must be a non-negative integer");
    }
    filters.olderThanMs = Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000;
  }
  if (input.minBytes !== undefined) {
    if (!Number.isInteger(input.minBytes) || input.minBytes < 0) {
      throw new Error("minBytes must be a non-negative integer");
    }
    filters.minBytes = input.minBytes;
  }
  if (input.urlPrefix !== undefined) {
    if (!input.urlPrefix.startsWith(`https://${CACHE_HOST}/`)) {
      throw new Error(`urlPrefix must start with https://${CACHE_HOST}/`);
    }
    filters.urlPrefix = input.urlPrefix;
  }
  return filters;
}

function matchesCleanupFilters(file: CachedFileInfo, filters: CleanupFilters): boolean {
  if (filters.olderThanMs !== undefined && new Date(file.modifiedAt).getTime() > filters.olderThanMs) {
    return false;
  }
  if (filters.minBytes !== undefined && file.bytes < filters.minBytes) {
    return false;
  }
  if (filters.urlPrefix !== undefined && !file.url.startsWith(filters.urlPrefix)) {
    return false;
  }
  return true;
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
