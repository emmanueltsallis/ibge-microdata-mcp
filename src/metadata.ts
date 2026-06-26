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

export type MetadataParser = "sas_input" | "excel_dictionary" | "text_dictionary" | "unsupported";
export type MetadataSourceStatus = "parsed" | "skipped" | "error";

export interface MetadataParserDiagnostic {
  parser: MetadataParser;
  status: MetadataSourceStatus;
  message: string;
}

export interface MetadataSourceSummary {
  path: string;
  entryName?: string;
  parser: MetadataParser;
  status: MetadataSourceStatus;
  recordCount: number;
  variableCount: number;
  message?: string;
  diagnostics?: MetadataParserDiagnostic[];
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

interface ParserOptions {
  search: string | null;
  variableLimit: number;
  includeCategories: boolean;
}

interface ParserAttempt {
  parser: Exclude<MetadataParser, "unsupported">;
  records: MetadataRecord[];
  message?: string;
  warnings?: string[];
}

interface MetadataParserAdapter {
  parser: Exclude<MetadataParser, "unsupported">;
  supports(sourceName: string): boolean;
  parse(descriptor: SourceDescriptor, options: ParserOptions): ParserAttempt;
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
const METADATA_PARSERS: MetadataParserAdapter[] = [
  {
    parser: "sas_input",
    supports: isTextLayoutPath,
    parse: parseSasInputDictionary,
  },
  {
    parser: "excel_dictionary",
    supports: isExcelPath,
    parse: parsePofExcelDictionary,
  },
  {
    parser: "excel_dictionary",
    supports: isExcelPath,
    parse: parseGenericExcelDictionary,
  },
  {
    parser: "text_dictionary",
    supports: isTextLayoutPath,
    parse: parseGenericTextDictionary,
  },
];

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
  options: ParserOptions
): ParsedSource {
  const sourceName = descriptor.entryName ?? descriptor.path;
  const adapters = METADATA_PARSERS.filter((parser) => parser.supports(sourceName));
  const diagnostics: MetadataParserDiagnostic[] = [];
  const warnings: string[] = [];

  if (adapters.length === 0) {
    return {
      source: {
        path: descriptor.path,
        ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
        parser: "unsupported",
        status: "skipped",
        recordCount: 0,
        variableCount: 0,
        message: "No parser registered for this metadata file type",
      },
      records: [],
      warnings: [`No parser registered for ${sourceName}`],
    };
  }

  for (const adapter of adapters) {
    try {
      const attempt = adapter.parse(descriptor, options);
      if (attempt.records.length > 0) {
        const variableCount = attempt.records.reduce((sum, record) => sum + record.variableCount, 0);
        diagnostics.push({
          parser: adapter.parser,
          status: "parsed",
          message: attempt.message ?? `Parsed ${attempt.records.length} record(s)`,
        });
        warnings.push(...(attempt.warnings ?? []));
        return {
          source: {
            path: descriptor.path,
            ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
            parser: adapter.parser,
            status: "parsed",
            recordCount: attempt.records.length,
            variableCount,
            diagnostics,
          },
          records: attempt.records,
          warnings,
        };
      }

      diagnostics.push({
        parser: adapter.parser,
        status: "skipped",
        message: attempt.message ?? "No variables recognized",
      });
      warnings.push(...(attempt.warnings ?? []));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        parser: adapter.parser,
        status: "error",
        message,
      });
      warnings.push(message);
    }
  }

  return {
    source: {
      path: descriptor.path,
      ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
      parser: "unsupported",
      status: diagnostics.some((diagnostic) => diagnostic.status === "error") ? "error" : "skipped",
      recordCount: 0,
      variableCount: 0,
      message: "No registered parser could convert this metadata file into structured variables",
      diagnostics,
    },
    records: [],
    warnings,
  };
}

function parsePofExcelDictionary(descriptor: SourceDescriptor, options: ParserOptions): ParserAttempt {
  const workbook = XLSX.read(descriptor.buffer, { type: "buffer" });
  const manifest = readPofDictionaryManifestFromWorkbook({
    workbook,
    dictionaryPath: descriptor.entryName ?? descriptor.path,
    search: options.search ?? undefined,
    variableLimit: options.variableLimit,
  });
  const records = pofManifestToMetadataRecords(manifest, descriptor, options.includeCategories);
  return {
    parser: "excel_dictionary",
    records,
    message:
      records.length === 0
        ? "No POF-style Excel dictionary sheets found"
        : `Parsed ${records.length} POF-style Excel dictionary sheet(s)`,
  };
}

function parseSasInputDictionary(descriptor: SourceDescriptor, options: ParserOptions): ParserAttempt {
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
    parser: "sas_input",
    records,
    message:
      records.length === 0
        ? "No SAS INPUT @position layout variables found"
        : `Parsed ${layout.length} SAS INPUT layout variable(s)`,
  };
}

function parseGenericExcelDictionary(descriptor: SourceDescriptor, options: ParserOptions): ParserAttempt {
  const workbook = XLSX.read(descriptor.buffer, { type: "buffer" });
  const records: MetadataRecord[] = [];
  const sheetSummaries: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = worksheetRows(workbook.Sheets[sheetName]);
    const parsed = parseGenericTableRows(rows, sheetName, descriptor, "excel_dictionary", options);
    if (parsed.record) {
      records.push(parsed.record);
    }
    sheetSummaries.push(`${sheetName}: ${parsed.message}`);
  }

  return {
    parser: "excel_dictionary",
    records,
    message:
      records.length === 0
        ? `No generic Excel dictionary table found. Scanned sheets: ${sheetSummaries.join("; ")}`
        : `Parsed ${records.length} generic Excel dictionary sheet(s)`,
  };
}

function parseGenericTextDictionary(descriptor: SourceDescriptor, options: ParserOptions): ParserAttempt {
  const text = decodeText(descriptor.buffer);
  const recordName = path.basename(descriptor.entryName ?? descriptor.path).replace(/\.[^.]+$/, "");
  const tableParses = parseTextAsCandidateTables(text);

  for (const tableParse of tableParses) {
    const parsed = parseGenericTableRows(tableParse.rows, recordName, descriptor, "text_dictionary", options);
    if (parsed.record) {
      return {
        parser: "text_dictionary",
        records: [parsed.record],
        message: `Parsed plain-text dictionary table using ${tableParse.description}`,
      };
    }
  }

  const lineVariables = parseLooseTextDictionaryLines(text);
  const record = genericVariablesToRecord(lineVariables, recordName, descriptor, "text_dictionary", options);
  return {
    parser: "text_dictionary",
    records: record ? [record] : [],
    message:
      record === null
        ? "No generic text dictionary table found; tried delimited, whitespace, and loose start-width-variable rows"
        : "Parsed loose plain-text start-width-variable rows",
  };
}

type GenericColumnKey = "start" | "end" | "width" | "decimals" | "name" | "description" | "categories" | "type" | "format";

interface GenericHeader {
  rowIndex: number;
  columns: Partial<Record<GenericColumnKey, number>>;
  score: number;
}

interface GenericRawVariable {
  name: string;
  type: LayoutVariableType;
  start: number;
  width: number;
  decimals?: number;
  format?: string;
  description: string;
  categories: ValueLabel[];
}

function parseGenericTableRows(
  rows: string[][],
  recordName: string,
  descriptor: SourceDescriptor,
  parser: Exclude<MetadataParser, "unsupported">,
  options: ParserOptions
): { record: MetadataRecord | null; message: string } {
  const header = findGenericHeader(rows);
  if (!header) {
    return {
      record: null,
      message: "no header row with variable, start, and width/end columns",
    };
  }

  const variables = parseGenericVariablesFromRows(rows.slice(header.rowIndex + 1), header.columns);
  const record = genericVariablesToRecord(variables, recordName, descriptor, parser, options);
  return {
    record,
    message:
      record === null
        ? `header found at row ${header.rowIndex + 1}, but no data rows parsed`
        : `header found at row ${header.rowIndex + 1}; parsed ${variables.length} variable row(s)`,
  };
}

function worksheetRows(sheet: XLSX.WorkSheet): string[][] {
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as Array<
    Array<string | number | boolean | null>
  >;
  return rawRows.map((row) => row.map((cell) => String(cell ?? "").trim()));
}

function findGenericHeader(rows: string[][]): GenericHeader | null {
  let best: GenericHeader | null = null;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const labels = rows[rowIndex].map(normalizeHeaderText);
    const columns: Partial<Record<GenericColumnKey, number>> = {};
    let score = 0;

    for (let columnIndex = 0; columnIndex < labels.length; columnIndex += 1) {
      const key = classifyHeader(labels[columnIndex]);
      if (!key || columns[key] !== undefined) continue;
      columns[key] = columnIndex;
      score += key === "name" || key === "start" || key === "width" || key === "end" ? 2 : 1;
    }

    const hasRequired = columns.name !== undefined && columns.start !== undefined && (columns.width !== undefined || columns.end !== undefined);
    if (!hasRequired) continue;
    const candidate = { rowIndex, columns, score };
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }
  return best;
}

function classifyHeader(header: string): GenericColumnKey | null {
  if (header === "") return null;
  if (/\b(posicao final|pos final|fim|final|end|ends at)\b/.test(header)) return "end";
  if (/\b(posicao inicial|pos inicial|inicio|inicial|start|starts at|from)\b/.test(header)) return "start";
  if (/\b(tamanho|largura|comprimento|width|size|length|bytes?)\b/.test(header)) return "width";
  if (/\b(decimais|decimal|casas decimais|decimals?)\b/.test(header)) return "decimals";
  if (/\b(categorias?|categoria|dominio|dominios|valores?|rotulos?|value labels?|labels?)\b/.test(header)) {
    return "categories";
  }
  if (/\b(tipo|type|classe|class)\b/.test(header)) return "type";
  if (/\b(formato|format|informat|mascara)\b/.test(header)) return "format";
  if (/\b(codigo da variavel|cod variavel|variavel|var|campo|mnemonico|mnem|code|variable)\b/.test(header)) {
    return "name";
  }
  if (/\b(descricao|descricao da variavel|description|pergunta|quesito|texto|rotulo|label|nome)\b/.test(header)) {
    return "description";
  }
  return null;
}

function parseGenericVariablesFromRows(
  rows: string[][],
  columns: Partial<Record<GenericColumnKey, number>>
): GenericRawVariable[] {
  const variables: GenericRawVariable[] = [];
  for (const row of rows) {
    if (row.every((cell) => cell.trim() === "")) continue;
    const start = integerCell(row, columns.start);
    const widthCell = integerCell(row, columns.width);
    const end = integerCell(row, columns.end);
    const width = widthCell ?? (start !== null && end !== null ? end - start + 1 : null);
    const name = stringAt(row, columns.name);
    if (start === null || width === null || width <= 0 || name === "") continue;

    const decimals = integerCell(row, columns.decimals);
    const description = stringAt(row, columns.description);
    const typeText = stringAt(row, columns.type);
    const format = stringAt(row, columns.format);
    const categories = parseGenericValueLabels(stringAt(row, columns.categories));
    variables.push({
      name,
      type: inferGenericVariableType({ name, description, decimals, typeText, format, categories }),
      start,
      width,
      ...(decimals === null ? {} : { decimals }),
      ...(format === "" ? {} : { format }),
      description,
      categories,
    });
  }
  return variables;
}

function genericVariablesToRecord(
  rawVariables: GenericRawVariable[],
  recordName: string,
  descriptor: SourceDescriptor,
  parser: Exclude<MetadataParser, "unsupported">,
  options: ParserOptions
): MetadataRecord | null {
  if (rawVariables.length === 0) return null;
  const filtered = filterVariables(rawVariables, options.search);
  const variables = filtered.slice(0, options.variableLimit).map((variable) => ({
    name: variable.name,
    type: variable.type,
    start: variable.start,
    end: variable.start + variable.width - 1,
    width: variable.width,
    ...(variable.decimals === undefined ? {} : { decimals: variable.decimals }),
    ...(variable.format === undefined ? {} : { format: variable.format }),
    description: variable.description,
    categories: options.includeCategories ? variable.categories : [],
  }));
  return {
    sourcePath: descriptor.path,
    ...(descriptor.entryName === undefined ? {} : { entryName: descriptor.entryName }),
    parser,
    recordName,
    dataEntryName: null,
    recordLength: Math.max(...rawVariables.map((variable) => variable.start + variable.width - 1)),
    variableCount: rawVariables.length,
    returnedVariables: variables.length,
    variables,
  };
}

function parseTextAsCandidateTables(text: string): Array<{ rows: string[][]; description: string }> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const candidates: Array<{ rows: string[][]; description: string }> = [];
  for (const delimiter of ["|", "\t", ";"]) {
    const rows = lines
      .filter((line) => line.includes(delimiter))
      .map((line) => line.split(delimiter).map((cell) => cell.trim()));
    if (rows.length >= 2) {
      candidates.push({ rows, description: delimiter === "\t" ? "tab delimiter" : `${delimiter} delimiter` });
    }
  }

  const whitespaceRows = lines
    .map((line) => line.trim().split(/\s{2,}/).map((cell) => cell.trim()))
    .filter((row) => row.length >= 3);
  if (whitespaceRows.length >= 2) {
    candidates.push({ rows: whitespaceRows, description: "multi-space columns" });
  }
  return candidates;
}

function parseLooseTextDictionaryLines(text: string): GenericRawVariable[] {
  const variables: GenericRawVariable[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLooseTextDictionaryLine(line);
    if (parsed) variables.push(parsed);
  }
  return variables;
}

function parseLooseTextDictionaryLine(line: string): GenericRawVariable | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return null;
  const start = parseIntegerText(tokens[0]);
  const width = parseIntegerText(tokens[1]);
  if (start === null || width === null || width <= 0) return null;

  let tokenIndex = 2;
  let decimals: number | undefined;
  const possibleDecimals = parseIntegerText(tokens[tokenIndex]);
  if (possibleDecimals !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[tokenIndex + 1] ?? "")) {
    decimals = possibleDecimals;
    tokenIndex += 1;
  }

  const name = tokens[tokenIndex] ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const description = tokens.slice(tokenIndex + 1).join(" ");
  const categories = parseGenericValueLabels(description);
  return {
    name,
    start,
    width,
    ...(decimals === undefined ? {} : { decimals }),
    type: inferGenericVariableType({ name, description, decimals, typeText: "", format: "", categories }),
    description,
    categories,
  };
}

function inferGenericVariableType(input: {
  name: string;
  description: string;
  decimals: number | null | undefined;
  typeText: string;
  format: string;
  categories: ValueLabel[];
}): LayoutVariableType {
  const normalizedType = normalizeText(`${input.typeText} ${input.format}`);
  if (/\b(character|char|string|texto|alfanumerico|alfanum|caractere)\b/.test(normalizedType)) return "string";
  if (/\b(numeric|number|integer|double|float|num|inteiro|decimal)\b/.test(normalizedType)) return "number";
  if (input.decimals !== undefined && input.decimals !== null && input.decimals > 0) return "number";
  if (input.categories.length > 0) return "string";

  const normalizedMeaning = normalizeText(`${input.name} ${input.description}`);
  if (/\b(fator|peso|rendimento|valor|despesa|receita|quantidade|deflator|imputado|estimado|total)\b/.test(normalizedMeaning)) {
    return "number";
  }
  return "string";
}

function parseGenericValueLabels(value: string): ValueLabel[] {
  const text = value.replace(/[–—]/g, "-").replace(/\r\n/g, "\n").trim();
  if (text === "") return [];

  const categories: ValueLabel[] = [];
  const pattern =
    /(?<value>[A-Za-z0-9_.-]+)\s*(?:-|:|=)\s*(?<label>.*?)(?=(?:\s+|\n|;|,)[A-Za-z0-9_.-]+\s*(?:-|:|=)|$)/gs;
  for (const match of text.matchAll(pattern)) {
    const rawValue = match.groups?.value.trim() ?? "";
    const rawLabel = match.groups?.label.replace(/[;,]\s*$/, "").trim() ?? "";
    if (rawValue !== "" && rawLabel !== "") {
      categories.push({ value: rawValue, label: rawLabel });
    }
  }
  return categories;
}

function integerCell(row: string[], column: number | undefined): number | null {
  if (column === undefined) return null;
  return parseIntegerText(row[column] ?? "");
}

function stringAt(row: string[], column: number | undefined): string {
  if (column === undefined) return "";
  return String(row[column] ?? "").trim();
}

function parseIntegerText(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  const match = /^-?\d+(?:\.0+)?$/.exec(normalized);
  if (!match) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeHeaderText(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
