import { readFile } from "node:fs/promises";
import path from "node:path";

import * as XLSX from "xlsx";
import yauzl from "yauzl";

import {
  parseSasInputLayout,
  type LayoutVariable,
  type LayoutVariableType,
  type ValueLabel,
} from "./layout.js";
import { readPofDictionaryManifestFromWorkbook, type PofDictionaryManifest } from "./pof.js";

export type MetadataParser = "sas_input" | "excel_dictionary" | "unsupported";
export type MetadataSourceStatus = "parsed" | "skipped" | "error";

export interface MetadataSourceSummary {
  path: string;
  entryName?: string;
  parser: MetadataParser;
  status: MetadataSourceStatus;
  recordCount: number;
  variableCount: number;
  message?: string;
}

export interface MetadataVariable {
  name: string;
  type: LayoutVariableType;
  start: number;
  end: number;
  width: number;
  decimals?: number;
  format?: string;
  description: string;
  categories: ValueLabel[];
}

export interface MetadataRecord {
  sourcePath: string;
  entryName?: string;
  parser: Exclude<MetadataParser, "unsupported">;
  recordName: string;
  dataEntryName?: string | null;
  recordLength: number;
  variableCount: number;
  returnedVariables: number;
  variables: MetadataVariable[];
}

export interface MetadataInventoryInput {
  paths?: string[];
  zipPaths?: string[];
  search?: string;
  variableLimit?: number;
  recordLimit?: number;
  includeCategories?: boolean;
  includeEmptySources?: boolean;
  maxZipEntries?: number;
}

export interface MetadataInventoryOutput {
  paths: string[];
  zipPaths: string[];
  totalSources: number;
  parsedSources: number;
  totalRecords: number;
  returnedRecords: number;
  totalVariables: number;
  returnedVariables: number;
  truncated: boolean;
  sources: MetadataSourceSummary[];
  records: MetadataRecord[];
  warnings: string[];
}

export interface MetadataVariableSearchInput extends Omit<MetadataInventoryInput, "search"> {
  query: string;
  limit?: number;
}

export interface MetadataVariableSearchMatch {
  sourcePath: string;
  entryName?: string;
  parser: Exclude<MetadataParser, "unsupported">;
  recordName: string;
  dataEntryName?: string | null;
  variable: MetadataVariable;
}

export interface MetadataVariableSearchOutput {
  query: string;
  totalMatches: number;
  returnedMatches: number;
  truncated: boolean;
  matches: MetadataVariableSearchMatch[];
  sources: MetadataSourceSummary[];
  warnings: string[];
}

interface ParsedSource {
  source: MetadataSourceSummary;
  records: MetadataRecord[];
  warnings: string[];
}

interface SourceDescriptor {
  path: string;
  entryName?: string;
  buffer: Buffer;
}

const DEFAULT_VARIABLE_LIMIT = 100;
const MAX_VARIABLE_LIMIT = 1000;
const DEFAULT_RECORD_LIMIT = 200;
const MAX_RECORD_LIMIT = 1000;
const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;

export async function buildMetadataInventory(input: MetadataInventoryInput): Promise<MetadataInventoryOutput> {
  const paths = input.paths ?? [];
  const zipPaths = input.zipPaths ?? [];
  if (paths.length === 0 && zipPaths.length === 0) {
    throw new Error("Provide at least one local dictionary/layout path or documentation ZIP path");
  }

  const search = normalizeSearch(input.search);
  const variableLimit = normalizePositiveInteger(input.variableLimit, DEFAULT_VARIABLE_LIMIT, MAX_VARIABLE_LIMIT, "variableLimit");
  const recordLimit = normalizePositiveInteger(input.recordLimit, DEFAULT_RECORD_LIMIT, MAX_RECORD_LIMIT, "recordLimit");
  const includeCategories = input.includeCategories ?? true;
  const includeEmptySources = input.includeEmptySources ?? true;
  const maxZipEntries = normalizePositiveInteger(input.maxZipEntries, DEFAULT_MAX_ZIP_ENTRIES, MAX_ZIP_ENTRIES, "maxZipEntries");

  const parsedSources: ParsedSource[] = [];
  for (const localPath of paths) {
    parsedSources.push(await parseLocalSource(localPath, { search, variableLimit, includeCategories }));
  }
  for (const zipPath of zipPaths) {
    parsedSources.push(...(await parseZipSources(zipPath, { search, variableLimit, includeCategories, maxZipEntries })));
  }

  const sources = parsedSources
    .map((parsed) => parsed.source)
    .filter((source) => includeEmptySources || source.status === "parsed");
  const allRecords = parsedSources.flatMap((parsed) => parsed.records);
  const records = allRecords.slice(0, recordLimit);
  const warnings = parsedSources.flatMap((parsed) => parsed.warnings);
  const totalVariables = allRecords.reduce((sum, record) => sum + record.variableCount, 0);
  const returnedVariables = records.reduce((sum, record) => sum + record.returnedVariables, 0);

  return {
    paths,
    zipPaths,
    totalSources: sources.length,
    parsedSources: sources.filter((source) => source.status === "parsed").length,
    totalRecords: allRecords.length,
    returnedRecords: records.length,
    totalVariables,
    returnedVariables,
    truncated: allRecords.length > records.length,
    sources,
    records,
    warnings,
  };
}

export async function searchMetadataVariables(
  input: MetadataVariableSearchInput
): Promise<MetadataVariableSearchOutput> {
  const query = input.query.trim();
  if (query === "") {
    throw new Error("query is required");
  }
  const limit = normalizePositiveInteger(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, "limit");
  const inventory = await buildMetadataInventory({
    ...input,
    search: query,
    variableLimit: MAX_VARIABLE_LIMIT,
    recordLimit: MAX_RECORD_LIMIT,
    includeCategories: input.includeCategories ?? true,
  });

  const matches: MetadataVariableSearchMatch[] = [];
  for (const record of inventory.records) {
    for (const variable of record.variables) {
      matches.push({
        sourcePath: record.sourcePath,
        ...(record.entryName === undefined ? {} : { entryName: record.entryName }),
        parser: record.parser,
        recordName: record.recordName,
        dataEntryName: record.dataEntryName,
        variable,
      });
    }
  }

  return {
    query,
    totalMatches: matches.length,
    returnedMatches: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    matches: matches.slice(0, limit),
    sources: inventory.sources,
    warnings: inventory.warnings,
  };
}

async function parseLocalSource(
  localPath: string,
  options: { search: string | null; variableLimit: number; includeCategories: boolean }
): Promise<ParsedSource> {
  try {
    const buffer = await readFile(localPath);
    return parseSource({ path: localPath, buffer }, options);
  } catch (error) {
    return errorParsedSource(localPath, undefined, error);
  }
}

async function parseZipSources(
  zipPath: string,
  options: { search: string | null; variableLimit: number; includeCategories: boolean; maxZipEntries: number }
): Promise<ParsedSource[]> {
  try {
    const descriptors = await readZipMetadataCandidates(zipPath, options.maxZipEntries);
    if (descriptors.length === 0) {
      return [
        {
          source: {
            path: zipPath,
            parser: "unsupported",
            status: "skipped",
            recordCount: 0,
            variableCount: 0,
            message: "No dictionary/layout candidates found in ZIP",
          },
          records: [],
          warnings: [],
        },
      ];
    }
    return descriptors.map((descriptor) => parseSource(descriptor, options));
  } catch (error) {
    return [errorParsedSource(zipPath, undefined, error)];
  }
}

function parseSource(
  descriptor: SourceDescriptor,
  options: { search: string | null; variableLimit: number; includeCategories: boolean }
): ParsedSource {
  const sourceName = descriptor.entryName ?? descriptor.path;
  try {
    if (isExcelPath(sourceName)) {
      return parseExcelDictionary(descriptor, options);
    }
    if (isTextLayoutPath(sourceName)) {
      return parseTextLayout(descriptor, options);
    }
    return {
      source: {
        path: descriptor.path,
        ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
        parser: "unsupported",
        status: "skipped",
        recordCount: 0,
        variableCount: 0,
        message: "Unsupported metadata file type",
      },
      records: [],
      warnings: [],
    };
  } catch (error) {
    return errorParsedSource(descriptor.path, descriptor.entryName, error);
  }
}

function parseExcelDictionary(
  descriptor: SourceDescriptor,
  options: { search: string | null; variableLimit: number; includeCategories: boolean }
): ParsedSource {
  const workbook = XLSX.read(descriptor.buffer, { type: "buffer" });
  const manifest = readPofDictionaryManifestFromWorkbook({
    workbook,
    dictionaryPath: descriptor.entryName ?? descriptor.path,
    search: options.search ?? undefined,
    variableLimit: options.variableLimit,
  });
  const records = pofManifestToMetadataRecords(manifest, descriptor, options.includeCategories);
  const variableCount = records.reduce((sum, record) => sum + record.variableCount, 0);
  const warnings = records.length === 0 ? [`No POF-style Excel dictionary sheets parsed from ${descriptor.entryName ?? descriptor.path}`] : [];

  return {
    source: {
      path: descriptor.path,
      ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
      parser: records.length === 0 ? "unsupported" : "excel_dictionary",
      status: records.length === 0 ? "skipped" : "parsed",
      recordCount: records.length,
      variableCount,
      ...(records.length === 0 ? { message: "No recognized position/size/variable headers found" } : {}),
    },
    records,
    warnings,
  };
}

function parseTextLayout(
  descriptor: SourceDescriptor,
  options: { search: string | null; variableLimit: number; includeCategories: boolean }
): ParsedSource {
  const text = decodeText(descriptor.buffer);
  const layout = parseSasInputLayout(text);
  const filtered = filterVariables(layout, options.search);
  const variables = filtered.slice(0, options.variableLimit).map((variable) =>
    layoutVariableToMetadataVariable(variable, options.includeCategories)
  );
  const recordName = path.basename(descriptor.entryName ?? descriptor.path).replace(/\.[^.]+$/, "");
  const recordLength = layout.length === 0 ? 0 : Math.max(...layout.map((variable) => variable.start + variable.width - 1));
  const records: MetadataRecord[] =
    layout.length === 0
      ? []
      : [
          {
            sourcePath: descriptor.path,
            ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
            parser: "sas_input",
            recordName,
            recordLength,
            variableCount: layout.length,
            returnedVariables: variables.length,
            variables,
          },
        ];

  return {
    source: {
      path: descriptor.path,
      ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
      parser: records.length === 0 ? "unsupported" : "sas_input",
      status: records.length === 0 ? "skipped" : "parsed",
      recordCount: records.length,
      variableCount: layout.length,
      ...(records.length === 0 ? { message: "No SAS INPUT @position layout variables found" } : {}),
    },
    records,
    warnings: records.length === 0 ? [`No SAS INPUT layout variables parsed from ${descriptor.entryName ?? descriptor.path}`] : [],
  };
}

function pofManifestToMetadataRecords(
  manifest: PofDictionaryManifest,
  descriptor: SourceDescriptor,
  includeCategories: boolean
): MetadataRecord[] {
  return manifest.records.map((record) => ({
    sourcePath: descriptor.path,
    ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
    parser: "excel_dictionary",
    recordName: record.sheetName,
    dataEntryName: record.dataEntryName,
    recordLength: record.recordLength,
    variableCount: record.variableCount,
    returnedVariables: record.variables.length,
    variables: record.variables.map((variable) => ({
      name: variable.name,
      type: variable.type,
      start: variable.start,
      end: variable.start + variable.width - 1,
      width: variable.width,
      decimals: variable.decimals,
      description: variable.description,
      categories: includeCategories ? variable.categories : [],
    })),
  }));
}

function layoutVariableToMetadataVariable(variable: LayoutVariable, includeCategories: boolean): MetadataVariable {
  return {
    name: variable.name,
    type: variable.type,
    start: variable.start,
    end: variable.start + variable.width - 1,
    width: variable.width,
    ...(variable.decimals === undefined ? {} : { decimals: variable.decimals }),
    ...(variable.format === undefined ? {} : { format: variable.format }),
    description: variable.description,
    categories: includeCategories ? variable.categories ?? [] : [],
  };
}

function filterVariables<T extends { name: string; description: string; categories?: ValueLabel[] }>(
  variables: T[],
  search: string | null
): T[] {
  if (search === null) return variables;
  return variables.filter((variable) => variableMatchesSearch(variable, search));
}

function variableMatchesSearch(variable: { name: string; description: string; categories?: ValueLabel[] }, search: string): boolean {
  return normalizeText(
    [
      variable.name,
      variable.description,
      ...(variable.categories ?? []).flatMap((category) => [category.value, category.label]),
    ].join(" ")
  ).includes(search);
}

function readZipMetadataCandidates(zipPath: string, maxEntries: number): Promise<SourceDescriptor[]> {
  return new Promise((resolve, reject) => {
    const descriptors: SourceDescriptor[] = [];
    let visited = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        fail(openError ?? new Error("Unable to open ZIP archive"));
        return;
      }

      const finish = () => {
        if (settled) return;
        settled = true;
        zipfile.close();
        resolve(descriptors);
      };

      zipfile.on("error", fail);
      zipfile.on("end", finish);
      zipfile.on("entry", (entry) => {
        if (visited >= maxEntries) {
          finish();
          return;
        }
        visited += 1;

        if (!isZipMetadataCandidate(entry.fileName) || entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new Error(`Unable to read ZIP entry ${entry.fileName}`));
            return;
          }

          const chunks: Buffer[] = [];
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("error", fail);
          readStream.on("end", () => {
            descriptors.push({
              path: zipPath,
              entryName: entry.fileName,
              buffer: Buffer.concat(chunks),
            });
            zipfile.readEntry();
          });
        });
      });

      zipfile.readEntry();
    });
  });
}

function errorParsedSource(pathName: string, entryName: string | undefined, error: unknown): ParsedSource {
  const message = error instanceof Error ? error.message : String(error);
  return {
    source: {
      path: pathName,
      ...(entryName === undefined ? {} : { entryName }),
      parser: "unsupported",
      status: "error",
      recordCount: 0,
      variableCount: 0,
      message,
    },
    records: [],
    warnings: [message],
  };
}

function decodeText(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  return utf8.includes("\uFFFD") ? buffer.toString("latin1") : utf8;
}

function isExcelPath(pathName: string): boolean {
  return /\.(xlsx?|xlsm)$/i.test(pathName);
}

function isTextLayoutPath(pathName: string): boolean {
  return /\.(txt|sas|inp|input)$/i.test(pathName);
}

function isZipMetadataCandidate(entryName: string): boolean {
  const normalized = normalizeText(entryName);
  if (!isExcelPath(entryName) && !isTextLayoutPath(entryName)) return false;
  return (
    normalized.includes("dicionario") ||
    normalized.includes("dictionary") ||
    normalized.includes("layout") ||
    normalized.includes("input") ||
    normalized.includes("questionario") ||
    normalized.includes("documentacao") ||
    normalized.includes("microdados")
  );
}

function normalizeSearch(search: string | undefined): string | null {
  const normalized = normalizeText(search ?? "");
  return normalized === "" ? null : normalized;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizePositiveInteger(
  value: number | undefined,
  defaultValue: number,
  cap: number,
  name: string
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(value, cap);
}
