import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import { z } from "zod";

import type { JsonValue, ParquetViewColumn, QueryParquetView } from "./parquet-query.js";

export interface ApplyHarmonizationRecipeInput {
  recipePath: string;
  views: QueryParquetView[];
  outputPath: string;
  sampleRows?: number;
  maxValidationRows?: number;
}

export interface HarmonizationRecipeSummary {
  schemaVersion: 1;
  name: string;
  description?: string;
  sources: HarmonizationRecipeSource[];
}

export interface HarmonizationRecipeSource {
  label: string;
  url?: string;
}

export interface HarmonizationValidationResult {
  name: string;
  passed: boolean;
  rows: Array<Record<string, JsonValue>>;
}

export interface ApplyHarmonizationRecipeOutput {
  recipePath: string;
  recipe: HarmonizationRecipeSummary;
  views: QueryParquetView[];
  outputPath: string;
  outputViewName: string;
  outputRows: number;
  outputColumns: ParquetViewColumn[];
  sampleRows: Array<Record<string, JsonValue>>;
  validationsPassed: boolean;
  validations: HarmonizationValidationResult[];
}

interface HarmonizationRecipe {
  schemaVersion: 1;
  name: string;
  description?: string;
  sources: HarmonizationRecipeSource[];
  requiredViews: Array<{
    name: string;
    columns: string[];
  }>;
  output: {
    viewName: string;
    sql: string;
  };
  validations: Array<{
    name: string;
    sql: string;
    expect: {
      column: string;
      equals: JsonValue;
    };
  }>;
}

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_SQL_PATTERN =
  /\b(copy|create|delete|drop|export|insert|install|load|pragma|set|update|attach|detach|alter)\b/i;
const DEFAULT_SAMPLE_ROWS = 0;
const MAX_SAMPLE_ROWS = 100;
const DEFAULT_MAX_VALIDATION_ROWS = 25;
const MAX_VALIDATION_ROWS = 100;

const sourceSchema = z.object({
  label: z.string().min(1),
  url: z.string().url().optional(),
});

const recipeSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(SQL_IDENTIFIER_PATTERN),
  description: z.string().min(1).optional(),
  sources: z.array(sourceSchema).optional(),
  requiredViews: z
    .array(
      z.object({
        name: z.string().regex(SQL_IDENTIFIER_PATTERN),
        columns: z.array(z.string().regex(SQL_IDENTIFIER_PATTERN)).min(1),
      })
    )
    .min(1),
  output: z.object({
    viewName: z.string().regex(SQL_IDENTIFIER_PATTERN),
    sql: z.string().min(1),
  }),
  validations: z
    .array(
      z.object({
        name: z.string().regex(SQL_IDENTIFIER_PATTERN),
        sql: z.string().min(1),
        expect: z.object({
          column: z.string().regex(SQL_IDENTIFIER_PATTERN),
          equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        }),
      })
    )
    .optional(),
});

export async function applyHarmonizationRecipe(
  input: ApplyHarmonizationRecipeInput
): Promise<ApplyHarmonizationRecipeOutput> {
  const recipe = await readRecipe(input.recipePath);
  const views = validateViews(input.views);
  const sampleRows = normalizeSampleRows(input.sampleRows);
  const maxValidationRows = normalizeMaxValidationRows(input.maxValidationRows);
  const outputSql = validateReadOnlySql(recipe.output.sql);
  const outputViewName = validateIdentifier(recipe.output.viewName, "output.viewName");

  for (const validation of recipe.validations) {
    validateReadOnlySql(validation.sql);
    validateIdentifier(validation.expect.column, `validations.${validation.name}.expect.column`);
  }

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    await createParquetViews(connection, views);
    await assertRequiredColumns(connection, recipe);
    await connection.run(`create or replace temp view ${sqlIdentifier(outputViewName)} as ${outputSql}`);

    const validations = await runRecipeValidations(connection, recipe, maxValidationRows);
    const failedValidation = validations.find((validation) => !validation.passed);
    if (failedValidation !== undefined) {
      throw new Error(`Recipe validation failed: ${failedValidation.name}`);
    }

    await mkdir(path.dirname(input.outputPath), { recursive: true });
    await connection.run(
      `copy (select * from ${sqlIdentifier(outputViewName)}) to ${sqlString(input.outputPath)} (format parquet)`
    );

    return {
      recipePath: input.recipePath,
      recipe: {
        schemaVersion: recipe.schemaVersion,
        name: recipe.name,
        ...(recipe.description === undefined ? {} : { description: recipe.description }),
        sources: recipe.sources,
      },
      views,
      outputPath: input.outputPath,
      outputViewName,
      outputRows: await countViewRows(connection, outputViewName),
      outputColumns: await describeViewColumns(connection, outputViewName),
      sampleRows: sampleRows > 0 ? await sampleViewRows(connection, outputViewName, sampleRows) : [],
      validationsPassed: true,
      validations,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function readRecipe(recipePath: string): Promise<HarmonizationRecipe> {
  const text = await readFile(recipePath, "utf8");
  const parsed = recipeSchema.parse(JSON.parse(text));
  return {
    schemaVersion: parsed.schemaVersion,
    name: parsed.name,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    sources: parsed.sources ?? [],
    requiredViews: parsed.requiredViews,
    output: parsed.output,
    validations: parsed.validations ?? [],
  };
}

async function createParquetViews(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  views: QueryParquetView[]
): Promise<void> {
  for (const view of views) {
    await connection.run(
      `create or replace view ${sqlIdentifier(view.name)} as select * from read_parquet(${parquetPathSql(
        view.parquetPaths
      )})`
    );
  }
}

async function assertRequiredColumns(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  recipe: HarmonizationRecipe
): Promise<void> {
  for (const requiredView of recipe.requiredViews) {
    const columns = await describeViewColumns(connection, requiredView.name);
    const existingColumns = new Set(columns.map((column) => column.name));
    for (const column of requiredView.columns) {
      if (!existingColumns.has(column)) {
        throw new Error(`Recipe requires missing column in view ${requiredView.name}: ${column}`);
      }
    }
  }
}

async function runRecipeValidations(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  recipe: HarmonizationRecipe,
  maxValidationRows: number
): Promise<HarmonizationValidationResult[]> {
  const results: HarmonizationValidationResult[] = [];

  for (const validation of recipe.validations) {
    const reader = await connection.runAndReadAll(
      `select * from (${validateReadOnlySql(validation.sql)}) as ibge_recipe_validation limit ${maxValidationRows}`
    );
    const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
    const actual = rows[0]?.[validation.expect.column];
    results.push({
      name: validation.name,
      passed: valuesEqual(actual, validation.expect.equals),
      rows,
    });
  }

  return results;
}

async function describeViewColumns(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  viewName: string
): Promise<ParquetViewColumn[]> {
  const reader = await connection.runAndReadAll(`describe select * from ${sqlIdentifier(viewName)}`);
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  return rows.map((row) => ({
    name: String(row.column_name),
    type: String(row.column_type),
  }));
}

async function countViewRows(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  viewName: string
): Promise<number> {
  const reader = await connection.runAndReadAll(`select count(*) as row_count from ${sqlIdentifier(viewName)}`);
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  return Number(rows[0]?.row_count ?? 0);
}

async function sampleViewRows(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  viewName: string,
  sampleRows: number
): Promise<Array<Record<string, JsonValue>>> {
  const reader = await connection.runAndReadAll(`select * from ${sqlIdentifier(viewName)} limit ${sampleRows}`);
  return reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
}

function validateViews(views: QueryParquetView[]): QueryParquetView[] {
  if (views.length === 0) {
    throw new Error("At least one Parquet view is required");
  }

  const seen = new Set<string>();
  return views.map((view) => {
    validateIdentifier(view.name, "views.name");
    if (seen.has(view.name)) {
      throw new Error(`Duplicate Parquet view name: ${view.name}`);
    }
    if (view.parquetPaths.length === 0) {
      throw new Error(`At least one Parquet path is required for view: ${view.name}`);
    }
    seen.add(view.name);
    return {
      name: view.name,
      parquetPaths: view.parquetPaths,
    };
  });
}

function validateReadOnlySql(sql: string): string {
  const trimmed = sql.trim();
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only SELECT or WITH queries are supported");
  }
  if (trimmed.includes(";")) {
    throw new Error("SQL must contain a single SELECT or WITH query without semicolons");
  }
  if (FORBIDDEN_SQL_PATTERN.test(trimmed)) {
    throw new Error("SQL contains a forbidden non-read-only keyword");
  }
  return trimmed;
}

function validateIdentifier(identifier: string, fieldName: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`${fieldName} must be a SQL identifier`);
  }
  return identifier;
}

function normalizeSampleRows(sampleRows: number | undefined): number {
  if (sampleRows === undefined) return DEFAULT_SAMPLE_ROWS;
  if (!Number.isInteger(sampleRows) || sampleRows < 0) {
    throw new Error("sampleRows must be a non-negative integer");
  }
  return Math.min(sampleRows, MAX_SAMPLE_ROWS);
}

function normalizeMaxValidationRows(maxValidationRows: number | undefined): number {
  if (maxValidationRows === undefined) return DEFAULT_MAX_VALIDATION_ROWS;
  if (!Number.isInteger(maxValidationRows) || maxValidationRows <= 0) {
    throw new Error("maxValidationRows must be a positive integer");
  }
  return Math.min(maxValidationRows, MAX_VALIDATION_ROWS);
}

function valuesEqual(left: unknown, right: JsonValue): boolean {
  if (left === undefined) return false;
  if (typeof right === "number" && (typeof left === "number" || typeof left === "string" || typeof left === "bigint")) {
    return Number(left) === right;
  }
  return left === right;
}

function parquetPathSql(paths: string[]): string {
  if (paths.length === 1) return sqlString(paths[0]);
  return `[${paths.map(sqlString).join(", ")}]`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
