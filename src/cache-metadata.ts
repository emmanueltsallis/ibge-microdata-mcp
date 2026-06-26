export const IBGE_CACHE_METADATA_SUFFIX = ".ibge-metadata.json";

export interface IbgeCacheMetadata {
  sourceUrl: string;
  resolvedUrl: string;
  transport: "https" | "http";
  usedFallback: boolean;
  contentLength: number | null;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
  bytesWritten: number;
  sha256: string;
  downloadedAt: string;
}

export function metadataPathForDataPath(filePath: string): string {
  return `${filePath}${IBGE_CACHE_METADATA_SUFFIX}`;
}

export function isCacheMetadataPath(filePath: string): boolean {
  return filePath.endsWith(IBGE_CACHE_METADATA_SUFFIX);
}
