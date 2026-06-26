import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildMetadataInventory,
  type MetadataInventoryInput,
  type MetadataInventoryOutput,
  type MetadataRecord,
  type MetadataVariable,
} from "./metadata.js";

export interface BaseDosDadosStyleExportInput extends MetadataInventoryInput {
  outputPath: string;
}

export interface BaseDosDadosStyleExportOutput {
  outputPath: string;
  rowsWritten: number;
  parsedSources: number;
  records: number;
  variables: number;
  truncated: boolean;
  warnings: string[];
}

interface ArchitectureRow {
  sourcePath: string;
  entryName: string;
  parser: string;
  recordName: string;
  dataEntryName: string;
  variableName: string;
  type: string;
  start: number;
  end: number;
  width: number;
  decimals: string;
  format: string;
  description: string;
  categoryCount: number;
}

const EXPORT_VARIABLE_LIMIT = 1000;
const EXPORT_RECORD_LIMIT = 1000;

export async function exportMetadataArchitectureCsv(
  input: BaseDosDadosStyleExportInput
): Promise<BaseDosDadosStyleExportOutput> {
  const inventory = await buildExportInventory(input);
  const rows = inventory.records.flatMap((record) =>
    record.variables.map((variable) => architectureRow(record, variable))
  );

  await writeCsv(input.outputPath, [
    [
      "source_path",
      "entry_name",
      "parser",
      "record_name",
      "data_entry_name",
      "variable_name",
      "type",
      "start",
      "end",
      "width",
      "decimals",
      "format",
      "description",
      "category_count",
    ],
    ...rows.map((row) => [
      row.sourcePath,
      row.entryName,
      row.parser,
      row.recordName,
      row.dataEntryName,
      row.variableName,
      row.type,
      row.start,
      row.end,
      row.width,
      row.decimals,
      row.format,
      row.description,
      row.categoryCount,
    ]),
  ]);

  return exportOutput(input.outputPath, inventory, rows.length);
}

export async function exportMetadataDictionaryCsv(
  input: BaseDosDadosStyleExportInput
): Promise<BaseDosDadosStyleExportOutput> {
  const inventory = await buildExportInventory({ ...input, includeCategories: true });
  const rows = inventory.records.flatMap((record) =>
    record.variables.flatMap((variable) =>
      variable.categories.map((category) => ({
        sourcePath: record.sourcePath,
        entryName: record.entryName ?? "",
        parser: record.parser,
        recordName: record.recordName,
        dataEntryName: record.dataEntryName ?? "",
        variableName: variable.name,
        value: category.value,
        label: category.label,
      }))
    )
  );

  await writeCsv(input.outputPath, [
    [
      "source_path",
      "entry_name",
      "parser",
      "record_name",
      "data_entry_name",
      "variable_name",
      "value",
      "label",
    ],
    ...rows.map((row) => [
      row.sourcePath,
      row.entryName,
      row.parser,
      row.recordName,
      row.dataEntryName,
      row.variableName,
      row.value,
      row.label,
    ]),
  ]);

  return exportOutput(input.outputPath, inventory, rows.length);
}

function architectureRow(record: MetadataRecord, variable: MetadataVariable): ArchitectureRow {
  return {
    sourcePath: record.sourcePath,
    entryName: record.entryName ?? "",
    parser: record.parser,
    recordName: record.recordName,
    dataEntryName: record.dataEntryName ?? "",
    variableName: variable.name,
    type: variable.type,
    start: variable.start,
    end: variable.end,
    width: variable.width,
    decimals: variable.decimals === undefined ? "" : String(variable.decimals),
    format: variable.format ?? "",
    description: variable.description,
    categoryCount: variable.categories.length,
  };
}

async function buildExportInventory(input: BaseDosDadosStyleExportInput): Promise<MetadataInventoryOutput> {
  return buildMetadataInventory({
    ...input,
    variableLimit: input.variableLimit ?? EXPORT_VARIABLE_LIMIT,
    recordLimit: input.recordLimit ?? EXPORT_RECORD_LIMIT,
    includeCategories: input.includeCategories ?? true,
  });
}

async function writeCsv(outputPath: string, rows: Array<Array<string | number>>): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`);
}

function csvCell(value: string | number): string {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportOutput(
  outputPath: string,
  inventory: MetadataInventoryOutput,
  rowsWritten: number
): BaseDosDadosStyleExportOutput {
  return {
    outputPath,
    rowsWritten,
    parsedSources: inventory.parsedSources,
    records: inventory.returnedRecords,
    variables: inventory.returnedVariables,
    truncated: inventory.truncated,
    warnings: inventory.warnings,
  };
}
