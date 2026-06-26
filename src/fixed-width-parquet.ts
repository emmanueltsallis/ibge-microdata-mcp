import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";

import { DuckDBInstance } from "@duckdb/node-api";
import yauzl from "yauzl";

import {
  parseSasInputLayout,
  readFixedWidthRecord,
  type FixedWidthValue,
  type LayoutVariable,
} from "./layout.js";

export interface FixedWidthParquetInputBase {
  layoutPath: string;
  outputPath: string;
  selectedVariables?: string[];
  rowLimit?: number;
}

export interface FixedWidthFileToParquetInput extends FixedWidthParquetInputBase {
  dataPath: string;
}

export interface FixedWidthZipEntryToParquetInput extends FixedWidthParquetInputBase {
  zipPath: string;
  entryName: string;
}

export interface FixedWidthZipEntryLayoutToParquetInput {
  layout: LayoutVariable[];
  zipPath: string;
  entryName: string;
  outputPath: string;
  selectedVariables?: string[];
  rowLimit?: number;
}

export interface FixedWidthParquetVariable {
  name: string;
  type: "string" | "number";
  start: number;
  width: number;
  description: string;
}

export interface FixedWidthParquetOutput {
  sourceName: string;
  outputPath: string;
  rowsRead: number;
  rowsWritten: number;
  variables: FixedWidthParquetVariable[];
}

export async function exportFixedWidthFileToParquet(
  input: FixedWidthFileToParquetInput
): Promise<FixedWidthParquetOutput> {
  const layout = await readLayout(input.layoutPath);
  const stream = createReadStream(input.dataPath, { encoding: "utf8" });
  return exportFixedWidthStreamToParquet(stream, {
    ...input,
    layout,
    sourceName: input.dataPath,
  });
}

export async function exportFixedWidthZipEntryToParquet(
  input: FixedWidthZipEntryToParquetInput
): Promise<FixedWidthParquetOutput> {
  const layout = await readLayout(input.layoutPath);
  const stream = await openZipEntryStream(input.zipPath, input.entryName);
  return exportFixedWidthStreamToParquet(stream, {
    ...input,
    layout,
    sourceName: input.entryName,
  });
}

export async function exportFixedWidthZipEntryLayoutToParquet(
  input: FixedWidthZipEntryLayoutToParquetInput
): Promise<FixedWidthParquetOutput> {
  const stream = await openZipEntryStream(input.zipPath, input.entryName);
  return exportFixedWidthStreamToParquet(stream, {
    ...input,
    sourceName: input.entryName,
  });
}

async function exportFixedWidthStreamToParquet(
  stream: Readable,
  input: Omit<FixedWidthParquetInputBase, "layoutPath"> & { layout: LayoutVariable[]; sourceName: string }
): Promise<FixedWidthParquetOutput> {
  const variables = selectLayoutVariables(input.layout, input.selectedVariables);
  const selectedNames = variables.map((variable) => variable.name);

  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await rm(input.outputPath, { force: true });

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  let rowsRead = 0;
  let rowsWritten = 0;

  try {
    await connection.run(createTableSql("fixed_width_export", variables));
    const appender = await connection.createAppender("fixed_width_export");
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        if (input.rowLimit !== undefined && rowsRead >= input.rowLimit) break;

        rowsRead += 1;
        const record = readFixedWidthRecord(line, variables, selectedNames);
        appendRecord(appender, variables, record);
        rowsWritten += 1;
      }
    } finally {
      appender.closeSync();
    }

    await connection.run(`copy fixed_width_export to ${sqlString(input.outputPath)} (format parquet)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }

  return {
    sourceName: input.sourceName,
    outputPath: input.outputPath,
    rowsRead,
    rowsWritten,
    variables: variables.map((variable) => ({
      name: variable.name,
      type: variable.type,
      start: variable.start,
      width: variable.width,
      description: variable.description,
    })),
  };
}

async function readLayout(layoutPath: string): Promise<LayoutVariable[]> {
  const layoutText = await readFile(layoutPath, "utf8");
  return parseSasInputLayout(layoutText);
}

function selectLayoutVariables(layout: LayoutVariable[], selectedVariables: string[] | undefined): LayoutVariable[] {
  if (!selectedVariables || selectedVariables.length === 0) {
    if (layout.length === 0) throw new Error("No variables found in the layout file");
    return layout;
  }

  const byName = new Map(layout.map((variable) => [variable.name, variable]));
  const missing = selectedVariables.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Variables not found in layout: ${missing.join(", ")}`);
  }

  return selectedVariables.map((name) => byName.get(name)!);
}

function createTableSql(tableName: string, variables: LayoutVariable[]): string {
  const columns = variables.map((variable) => {
    const columnType = variable.type === "string" ? "varchar" : "double";
    return `${sqlIdentifier(variable.name)} ${columnType}`;
  });
  return `create or replace table ${sqlIdentifier(tableName)} (${columns.join(", ")})`;
}

function appendRecord(
  appender: Awaited<ReturnType<Awaited<ReturnType<DuckDBInstance["connect"]>>["createAppender"]>>,
  variables: LayoutVariable[],
  record: Record<string, FixedWidthValue>
): void {
  for (const variable of variables) {
    const value = record[variable.name];
    if (value === null) {
      appender.appendNull();
    } else if (variable.type === "string") {
      appender.appendVarchar(String(value));
    } else {
      appender.appendDouble(Number(value));
    }
  }
  appender.endRow();
}

function openZipEntryStream(zipPath: string, entryName: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
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

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new Error(`Unable to read ZIP entry: ${entryName}`));
            return;
          }
          settled = true;
          readStream.on("end", () => zipfile.close());
          readStream.on("error", () => zipfile.close());
          resolve(readStream);
        });
      });
      zipfile.on("end", () => fail(new Error(`ZIP entry not found: ${entryName}`)));
      zipfile.on("error", fail);
    });
  });
}

function sqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
