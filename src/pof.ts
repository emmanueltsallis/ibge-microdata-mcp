import { readFile } from "node:fs/promises";

import * as XLSX from "xlsx";

import type { LayoutVariable, LayoutVariableType } from "./layout.js";
import { exportFixedWidthZipEntryLayoutToParquet, type FixedWidthParquetOutput } from "./fixed-width-parquet.js";
import { listZipEntries } from "./zip.js";

export interface PofDictionaryManifestInput {
  dictionaryPath: string;
  dataZipPath?: string;
  search?: string;
  variableLimit?: number;
}

export interface PofZipRecordToParquetInput {
  dictionaryPath: string;
  zipPath: string;
  recordName: string;
  outputPath: string;
  selectedVariables?: string[];
  rowLimit?: number;
}

export interface PofVariable {
  name: string;
  start: number;
  width: number;
  decimals: number;
  type: LayoutVariableType;
  description: string;
}

export interface PofRecordManifest {
  sheetName: string;
  dataEntryName: string | null;
  variableCount: number;
  recordLength: number;
  variables: PofVariable[];
}

export interface PofDictionaryManifest {
  dictionaryPath: string;
  dataZipPath: string | null;
  recordCount: number;
  records: PofRecordManifest[];
}

const DEFAULT_VARIABLE_LIMIT = 50;
const MAX_VARIABLE_LIMIT = 1000;

const POF_2017_2018_ENTRY_BY_SHEET = new Map<string, string>([
  ["domicilio", "DOMICILIO.txt"],
  ["morador", "MORADOR.txt"],
  ["morador qualidade de vida", "MORADOR_QUALI_VIDA.txt"],
  ["aluguel estimado", "ALUGUEL_ESTIMADO.txt"],
  ["despesa coletiva", "DESPESA_COLETIVA.txt"],
  ["servicos nao monetarios pof 2", "SERVICO_NAO_MONETARIO_POF2.txt"],
  ["inventario", "INVENTARIO.txt"],
  ["caderneta coletiva", "CADERNETA_COLETIVA.txt"],
  ["despesa individual", "DESPESA_INDIVIDUAL.txt"],
  ["servicos nao monetarios pof 4", "SERVICO_NAO_MONETARIO_POF4.txt"],
  ["restricao saude", "RESTRICAO_PRODUTOS_SERVICOS_SAUDE.txt"],
  ["rendimento do trabalho", "RENDIMENTO_TRABALHO.txt"],
  ["outros rendimentos", "OUTROS_RENDIMENTOS.txt"],
  ["condicoes de vida", "CONDICOES_VIDA.txt"],
  ["caracteristicas da dieta", "CARACTERISTICAS_DIETA.txt"],
  ["consumo alimentar", "CONSUMO_ALIMENTAR.txt"],
]);

export async function readPofDictionaryManifest(
  input: PofDictionaryManifestInput
): Promise<PofDictionaryManifest> {
  const workbook = await readWorkbook(input.dictionaryPath);
  const zipEntries = input.dataZipPath ? await listZipEntries(input.dataZipPath) : [];
  const zipEntryNames = new Set(zipEntries.map((entry) => entry.fileName));
  const search = normalizeSearch(input.search);
  const variableLimit = normalizeVariableLimit(input.variableLimit);
  const records: PofRecordManifest[] = [];

  for (const sheetName of workbook.SheetNames) {
    const variables = parsePofSheet(workbook.Sheets[sheetName]);
    if (variables.length === 0) continue;

    const matchingVariables = search
      ? variables.filter((variable) => variableMatchesSearch(variable, search))
      : variables;
    const dataEntryName = resolvePofDataEntryName(sheetName, zipEntryNames);

    records.push({
      sheetName,
      dataEntryName,
      variableCount: variables.length,
      recordLength: Math.max(...variables.map((variable) => variable.start + variable.width - 1)),
      variables: matchingVariables.slice(0, variableLimit),
    });
  }

  return {
    dictionaryPath: input.dictionaryPath,
    dataZipPath: input.dataZipPath ?? null,
    recordCount: records.length,
    records,
  };
}

export async function exportPofZipRecordToParquet(
  input: PofZipRecordToParquetInput
): Promise<FixedWidthParquetOutput> {
  const workbook = await readWorkbook(input.dictionaryPath);
  const sheetName = findPofSheetName(workbook.SheetNames, input.recordName);
  const variables = parsePofSheet(workbook.Sheets[sheetName]);
  const zipEntryNames = new Set((await listZipEntries(input.zipPath)).map((entry) => entry.fileName));
  const entryName = resolvePofDataEntryName(sheetName, zipEntryNames);
  if (!entryName) {
    throw new Error(`Could not resolve a POF data ZIP entry for record: ${input.recordName}`);
  }

  return exportFixedWidthZipEntryLayoutToParquet({
    layout: variables.map(toLayoutVariable),
    zipPath: input.zipPath,
    entryName,
    outputPath: input.outputPath,
    selectedVariables: input.selectedVariables,
    rowLimit: input.rowLimit,
  });
}

async function readWorkbook(path: string): Promise<XLSX.WorkBook> {
  const buffer = await readFile(path);
  return XLSX.read(buffer, { type: "buffer" });
}

function parsePofSheet(sheet: XLSX.WorkSheet): PofVariable[] {
  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);
  let headerIndex = -1;
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    if (normalizeCell(cellValue(sheet, rowIndex, 0)) === "posicao inicial") {
      headerIndex = rowIndex;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const variables: PofVariable[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex <= range.e.r; rowIndex += 1) {
    const start = numberCell(cellValue(sheet, rowIndex, 0));
    const width = numberCell(cellValue(sheet, rowIndex, 1));
    const decimals = numberCell(cellValue(sheet, rowIndex, 2)) ?? 0;
    const name = stringCell(cellValue(sheet, rowIndex, 3));
    const description = stringCell(cellValue(sheet, rowIndex, 4));
    if (start === null || width === null || name === "") continue;

    variables.push({
      name,
      start,
      width,
      decimals,
      type: inferPofVariableType(name, description, decimals),
      description,
    });
  }

  return variables;
}

function cellValue(sheet: XLSX.WorkSheet, row: number, column: number): string | number | undefined {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
  return cell?.v as string | number | undefined;
}

function findPofSheetName(sheetNames: string[], recordName: string): string {
  const normalizedRecord = normalizeText(recordName);
  const found = sheetNames.find(
    (sheetName) => normalizeText(sheetName) === normalizedRecord || resolveKnownEntry(sheetName) === recordName
  );
  if (!found) {
    throw new Error(`POF dictionary sheet not found for record: ${recordName}`);
  }
  return found;
}

function resolvePofDataEntryName(sheetName: string, zipEntryNames: Set<string>): string | null {
  const knownEntry = resolveKnownEntry(sheetName);
  if (knownEntry && (zipEntryNames.size === 0 || zipEntryNames.has(knownEntry))) return knownEntry;

  const normalizedSheet = normalizeText(sheetName).replace(/\s+/g, "_").toUpperCase();
  const found = [...zipEntryNames].find((entryName) => normalizeText(entryName).replace(/\s+/g, "_").includes(normalizedSheet));
  return found ?? knownEntry;
}

function resolveKnownEntry(sheetName: string): string | null {
  return POF_2017_2018_ENTRY_BY_SHEET.get(normalizeText(sheetName)) ?? null;
}

function toLayoutVariable(variable: PofVariable): LayoutVariable {
  return {
    name: variable.name,
    start: variable.start,
    zeroBasedStart: variable.start - 1,
    width: variable.width,
    type: variable.type,
    description: variable.description,
    decimals: variable.decimals,
  };
}

function inferPofVariableType(name: string, description: string, decimals: number): LayoutVariableType {
  if (decimals > 0) return "number";
  const normalized = normalizeText(`${name} ${description}`);
  if (/\b(fator|peso|rendimento|valor|despesa|receita|quantidade|deflator|imputado|estimado)\b/.test(normalized)) {
    return "number";
  }
  return "string";
}

function variableMatchesSearch(variable: PofVariable, search: string): boolean {
  return normalizeText(`${variable.name} ${variable.description}`).includes(search);
}

function normalizeSearch(search: string | undefined): string | null {
  const normalized = normalizeText(search ?? "");
  return normalized === "" ? null : normalized;
}

function normalizeVariableLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_VARIABLE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("variableLimit must be a positive integer");
  }
  return Math.min(limit, MAX_VARIABLE_LIMIT);
}

function normalizeCell(value: string | number | undefined): string {
  return normalizeText(String(value ?? ""));
}

function stringCell(value: string | number | undefined): string {
  return String(value ?? "").trim();
}

function numberCell(value: string | number | undefined): number | null {
  const text = stringCell(value).replace(",", ".");
  if (text === "") return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
