import { fetchDirectoryEntries } from "./http.js";
import type { DirectoryEntry } from "./catalog.js";

export interface DiscoverMicrodataInput {
  rootUrl?: string;
  maxDepth?: number;
  maxDirectories?: number;
  includeDocumentation?: boolean;
}

export type MicrodataDiscoveryRole =
  | "microdata_directory"
  | "data_file"
  | "metadata_file"
  | "documentation_archive";

export interface MicrodataDiscoveryMatch {
  name: string;
  url: string;
  kind: DirectoryEntry["kind"];
  depth: number;
  roles: MicrodataDiscoveryRole[];
  metadataKind?: string;
  matchedBecause: string[];
}

export interface DiscoverMicrodataOutput {
  rootUrl: string;
  maxDepth: number;
  maxDirectories: number;
  directoriesVisited: number;
  truncated: boolean;
  matches: MicrodataDiscoveryMatch[];
}

const DEFAULT_ROOT_URL = "https://ftp.ibge.gov.br/";
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_DIRECTORIES = 50;
const MAX_DEPTH_CAP = 8;
const MAX_DIRECTORIES_CAP = 500;

export async function discoverMicrodataFiles(input: DiscoverMicrodataInput = {}): Promise<DiscoverMicrodataOutput> {
  const rootUrl = normalizeDirectoryUrl(input.rootUrl ?? DEFAULT_ROOT_URL);
  assertOfficialIbgeUrl(rootUrl);

  const maxDepth = clampPositiveInteger(input.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP, "maxDepth");
  const maxDirectories = clampPositiveInteger(
    input.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    MAX_DIRECTORIES_CAP,
    "maxDirectories"
  );
  const includeDocumentation = input.includeDocumentation ?? true;

  const queue: Array<{ url: string; depth: number }> = [{ url: rootUrl, depth: 0 }];
  const seenDirectories = new Set<string>();
  const seenMatches = new Set<string>();
  const matches: MicrodataDiscoveryMatch[] = [];
  let directoriesVisited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth || seenDirectories.has(current.url)) continue;
    if (directoriesVisited >= maxDirectories) {
      truncated = true;
      break;
    }

    seenDirectories.add(current.url);
    directoriesVisited += 1;

    const entries = await fetchDirectoryEntries(current.url);
    for (const entry of entries) {
      const depth = current.depth + 1;
      const match = classifyDiscoveryEntry(entry, depth, includeDocumentation);
      if (depth <= maxDepth && match.matchedBecause.length > 0 && !seenMatches.has(entry.url)) {
        seenMatches.add(entry.url);
        matches.push({
          name: entry.name,
          url: entry.url,
          kind: entry.kind,
          depth,
          roles: match.roles,
          ...(match.metadataKind === null ? {} : { metadataKind: match.metadataKind }),
          matchedBecause: match.matchedBecause,
        });
      }

      if (entry.kind === "directory" && depth <= maxDepth && !seenDirectories.has(entry.url)) {
        queue.push({ url: normalizeDirectoryUrl(entry.url), depth });
      }
    }
  }

  return {
    rootUrl,
    maxDepth,
    maxDirectories,
    directoriesVisited,
    truncated,
    matches,
  };
}

export async function discoverMetadataFiles(input: DiscoverMicrodataInput = {}): Promise<DiscoverMicrodataOutput> {
  const result = await discoverMicrodataFiles({ ...input, includeDocumentation: true });
  const matches = result.matches.filter((match) =>
    match.roles.some((role) => role === "metadata_file" || role === "documentation_archive")
  );
  return {
    ...result,
    matches,
  };
}

function classifyDiscoveryEntry(
  entry: DirectoryEntry,
  depth: number,
  includeDocumentation: boolean
): { matchedBecause: string[]; roles: MicrodataDiscoveryRole[]; metadataKind: string | null } {
  const matchedBecause: string[] = [];
  const roles: MicrodataDiscoveryRole[] = [];
  const normalizedUrl = normalizeText(entry.url);
  const normalizedName = normalizeText(entry.name);
  const underMicrodataDirectory = normalizedUrl.includes("/microdados/");

  if (entry.kind === "directory" && normalizedName.includes("microdados")) {
    matchedBecause.push("microdata_directory");
    roles.push("microdata_directory");
  }

  if (entry.kind === "file" && isDownloadFile(entry.name)) {
    const metadataKind = metadataKindForName(normalizedName);
    const documentationArchive = isDocumentationArchive(normalizedName);

    if (underMicrodataDirectory && metadataKind === null && !documentationArchive) {
      matchedBecause.push("file_under_microdata_directory");
      roles.push("data_file");
    }
    if (metadataKind === null && normalizedName.includes("microdados")) {
      matchedBecause.push("microdata_file_name");
      roles.push("data_file");
    }
    if (metadataKind === null && normalizedName.startsWith("dados") && depth > 0) {
      matchedBecause.push("data_file_name");
      roles.push("data_file");
    }
    if (includeDocumentation && isDocumentationFileName(normalizedName)) {
      matchedBecause.push("documentation_file_name");
      roles.push(documentationArchive ? "documentation_archive" : "metadata_file");
    }
    if (includeDocumentation && metadataKind !== null) {
      matchedBecause.push(`${metadataKind}_file_name`);
      roles.push("metadata_file");
    }

    return {
      matchedBecause: unique(matchedBecause),
      roles: unique(roles),
      metadataKind,
    };
  }

  return {
    matchedBecause: unique(matchedBecause),
    roles: unique(roles),
    metadataKind: null,
  };
}

function metadataKindForName(normalizedName: string): string | null {
  if (normalizedName.includes("dicionario") || normalizedName.includes("dictionary")) return "dictionary";
  if (normalizedName.includes("layout")) return "layout";
  if (normalizedName.includes("input")) return "input";
  if (normalizedName.includes("codebook")) return "codebook";
  if (normalizedName.includes("questionario")) return "questionnaire";
  if (normalizedName.includes("documentacao")) return "documentation";
  return null;
}

function isDocumentationArchive(normalizedName: string): boolean {
  return normalizedName.endsWith(".zip") && isDocumentationFileName(normalizedName);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isDownloadFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".zip") || lower.endsWith(".txt") || lower.endsWith(".xls") || lower.endsWith(".xlsx");
}

function isDocumentationFileName(normalizedName: string): boolean {
  return (
    normalizedName.includes("documentacao") ||
    normalizedName.includes("dicionario") ||
    normalizedName.includes("dictionary") ||
    normalizedName.includes("layout") ||
    normalizedName.includes("input") ||
    normalizedName.includes("codebook") ||
    normalizedName.includes("questionario")
  );
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function normalizeDirectoryUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

function assertOfficialIbgeUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== "ftp.ibge.gov.br") {
    throw new Error("Only ftp.ibge.gov.br URLs are supported");
  }
}

function clampPositiveInteger(value: number, cap: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, cap);
}
