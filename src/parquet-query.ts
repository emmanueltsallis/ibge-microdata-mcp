import { DuckDBInstance } from "@duckdb/node-api";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface QueryParquetInput {
  parquetPaths: string[];
  sql: string;
  maxRows?: number;
}

export interface QueryParquetOutput {
  parquetPaths: string[];
  sql: string;
  rowCount: number;
  truncated: boolean;
  rows: Array<Record<string, JsonValue>>;
}

export interface QueryParquetView {
  name: string;
  parquetPaths: string[];
}

export interface QueryParquetViewsInput {
  views: QueryParquetView[];
  sql: string;
  maxRows?: number;
}

export interface QueryParquetViewsOutput {
  views: QueryParquetView[];
  sql: string;
  rowCount: number;
  truncated: boolean;
  rows: Array<Record<string, JsonValue>>;
}

export interface DescribeParquetViewsInput {
  views: QueryParquetView[];
  includeRowCounts?: boolean;
  sampleRows?: number;
}

export interface ParquetViewColumn {
  name: string;
  type: string;
}

export interface ParquetViewDescription {
  name: string;
  parquetPaths: string[];
  columns: ParquetViewColumn[];
  rowCount?: number;
  sampleRows: Array<Record<string, JsonValue>>;
}

export interface DescribeParquetViewsOutput {
  views: ParquetViewDescription[];
}

export interface ProfileParquetViewsInput {
  views: QueryParquetView[];
  columns?: string[];
  maxColumns?: number;
  topK?: number;
  sampleRows?: number;
}

export interface ParquetColumnTopValue {
  value: JsonValue;
  count: number;
}

export interface ParquetNumericProfile {
  min: number | null;
  max: number | null;
  mean: number | null;
}

export interface ParquetColumnProfile extends ParquetViewColumn {
  nullCount: number;
  nonNullCount: number;
  numeric?: ParquetNumericProfile;
  topValues: ParquetColumnTopValue[];
}

export interface ParquetViewProfile {
  name: string;
  parquetPaths: string[];
  rowCount: number;
  totalColumns: number;
  profiledColumns: number;
  columnsTruncated: boolean;
  columns: ParquetColumnProfile[];
  sampleRows: Array<Record<string, JsonValue>>;
}

export interface ProfileParquetViewsOutput {
  views: ParquetViewProfile[];
}

export interface WeightedDistributionInput {
  views: QueryParquetView[];
  unitSql: string;
  valueColumn: string;
  weightColumn: string;
  groupColumn?: string;
  topPercents?: number[];
  maxGroups?: number;
}

export interface WeightedDistributionGroupSummary {
  groupValue: string;
  weight: number;
  totalValue: number;
  populationShare: number;
  valueShare: number | null;
  weightedMean: number | null;
}

export interface WeightedDistributionTopGroupSummary {
  groupValue: string;
  weight: number;
  totalValue: number;
  populationShareWithinBracket: number;
  valueShareWithinBracket: number | null;
  valueShareOfTotal: number | null;
}

export interface WeightedDistributionTopBracket {
  percent: number;
  cutoffValue: number | null;
  thresholdWeight: number;
  weight: number;
  totalValue: number;
  valueShare: number | null;
  weightedMean: number | null;
  groups: WeightedDistributionTopGroupSummary[];
}

export interface WeightedDistributionOutput {
  views: QueryParquetView[];
  unitSql: string;
  valueColumn: string;
  weightColumn: string;
  groupColumn?: string;
  rowsUsed: number;
  distinctValues: number;
  totalWeight: number;
  totalValue: number;
  weightedMean: number | null;
  groups: WeightedDistributionGroupSummary[];
  groupsTruncated: boolean;
  topBrackets: WeightedDistributionTopBracket[];
}

const DEFAULT_MAX_ROWS = 1000;
const MAX_ALLOWED_ROWS = 10000;
const DEFAULT_SAMPLE_ROWS = 0;
const MAX_SAMPLE_ROWS = 100;
const DEFAULT_PROFILE_MAX_COLUMNS = 25;
const MAX_PROFILE_COLUMNS = 200;
const DEFAULT_PROFILE_TOP_K = 5;
const MAX_PROFILE_TOP_K = 50;
const DEFAULT_TOP_PERCENTS = [0.01, 0.05, 0.1];
const DEFAULT_MAX_GROUPS = 100;
const MAX_GROUPS = 1000;
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_SQL_PATTERN =
  /\b(copy|create|delete|drop|export|insert|install|load|pragma|set|update|attach|detach|alter)\b/i;

export async function queryParquetFiles(input: QueryParquetInput): Promise<QueryParquetOutput> {
  if (input.parquetPaths.length === 0) {
    throw new Error("At least one Parquet path is required");
  }

  const result = await queryParquetViews({
    views: [{ name: "microdata", parquetPaths: input.parquetPaths }],
    sql: input.sql,
    maxRows: input.maxRows,
  });

  return {
    parquetPaths: input.parquetPaths,
    sql: result.sql,
    rowCount: result.rowCount,
    truncated: result.truncated,
    rows: result.rows,
  };
}

export async function queryParquetViews(input: QueryParquetViewsInput): Promise<QueryParquetViewsOutput> {
  const views = validateViews(input.views);
  const sql = validateReadOnlySql(input.sql);
  const maxRows = normalizeMaxRows(input.maxRows);
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    await createParquetViews(connection, views);
    const reader = await connection.runAndReadAll(`select * from (${sql}) as ibge_query limit ${maxRows + 1}`);
    const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
    const truncated = rows.length > maxRows;
    return {
      views,
      sql,
      rowCount: Math.min(rows.length, maxRows),
      truncated,
      rows: rows.slice(0, maxRows),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function describeParquetViews(input: DescribeParquetViewsInput): Promise<DescribeParquetViewsOutput> {
  const views = validateViews(input.views);
  const sampleRows = normalizeSampleRows(input.sampleRows);
  const includeRowCounts = input.includeRowCounts ?? false;
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    await createParquetViews(connection, views);
    const descriptions: ParquetViewDescription[] = [];

    for (const view of views) {
      const columns = await describeViewColumns(connection, view.name);
      const rowCount = includeRowCounts ? await countViewRows(connection, view.name) : undefined;
      const sample = sampleRows > 0 ? await sampleViewRows(connection, view.name, sampleRows) : [];
      descriptions.push({
        name: view.name,
        parquetPaths: view.parquetPaths,
        columns,
        rowCount,
        sampleRows: sample,
      });
    }

    return { views: descriptions };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function profileParquetViews(input: ProfileParquetViewsInput): Promise<ProfileParquetViewsOutput> {
  const views = validateViews(input.views);
  const requestedColumns = normalizeProfileColumns(input.columns);
  const maxColumns = normalizeProfileMaxColumns(input.maxColumns);
  const topK = normalizeProfileTopK(input.topK);
  const sampleRows = normalizeSampleRows(input.sampleRows);
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    await createParquetViews(connection, views);
    const profiles: ParquetViewProfile[] = [];

    for (const view of views) {
      const allColumns = await describeViewColumns(connection, view.name);
      const selectedColumns =
        requestedColumns === undefined
          ? allColumns.slice(0, maxColumns)
          : selectRequestedColumns(view.name, allColumns, requestedColumns);
      const rowCount = await countViewRows(connection, view.name);
      const sample = sampleRows > 0 ? await sampleViewRows(connection, view.name, sampleRows) : [];
      const columns: ParquetColumnProfile[] = [];

      for (const column of selectedColumns) {
        columns.push(await profileViewColumn(connection, view.name, column, topK));
      }

      profiles.push({
        name: view.name,
        parquetPaths: view.parquetPaths,
        rowCount,
        totalColumns: allColumns.length,
        profiledColumns: columns.length,
        columnsTruncated: requestedColumns === undefined && allColumns.length > selectedColumns.length,
        columns,
        sampleRows: sample,
      });
    }

    return { views: profiles };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function weightedDistributionFromParquetViews(
  input: WeightedDistributionInput
): Promise<WeightedDistributionOutput> {
  const views = validateViews(input.views);
  const unitSql = validateReadOnlySql(input.unitSql);
  const valueColumn = validateColumnIdentifier(input.valueColumn, "valueColumn");
  const weightColumn = validateColumnIdentifier(input.weightColumn, "weightColumn");
  const groupColumn =
    input.groupColumn === undefined ? undefined : validateColumnIdentifier(input.groupColumn, "groupColumn");
  const topPercents = normalizeTopPercents(input.topPercents);
  const maxGroups = normalizeMaxGroups(input.maxGroups);

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    await createParquetViews(connection, views);
    await createDistributionUnitsView(connection, {
      unitSql,
      valueColumn,
      weightColumn,
      groupColumn,
    });

    const totals = await readDistributionTotals(connection);
    const valueBuckets = await readValueBuckets(connection);
    const groupBuckets = groupColumn === undefined ? [] : await readGroupBuckets(connection);
    const groupSummaries =
      groupColumn === undefined ? { groups: [], truncated: false } : await readGroupSummaries(connection, totals, maxGroups);

    return {
      views,
      unitSql,
      valueColumn,
      weightColumn,
      ...(groupColumn === undefined ? {} : { groupColumn }),
      rowsUsed: totals.rowsUsed,
      distinctValues: valueBuckets.length,
      totalWeight: totals.totalWeight,
      totalValue: totals.totalValue,
      weightedMean: safeDivide(totals.totalValue, totals.totalWeight),
      groups: groupSummaries.groups,
      groupsTruncated: groupSummaries.truncated,
      topBrackets: calculateTopBrackets({
        valueBuckets,
        groupBuckets,
        totalWeight: totals.totalWeight,
        totalValue: totals.totalValue,
        topPercents,
      }),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
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

function selectRequestedColumns(
  viewName: string,
  allColumns: ParquetViewColumn[],
  requestedColumns: string[]
): ParquetViewColumn[] {
  const byName = new Map(allColumns.map((column) => [column.name, column]));
  return requestedColumns.map((columnName) => {
    const column = byName.get(columnName);
    if (column === undefined) {
      throw new Error(`Column not found in view ${viewName}: ${columnName}`);
    }
    return column;
  });
}

async function profileViewColumn(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  viewName: string,
  column: ParquetViewColumn,
  topK: number
): Promise<ParquetColumnProfile> {
  const view = sqlIdentifier(viewName);
  const columnSql = sqlIdentifier(column.name);
  const statsReader = await connection.runAndReadAll(
    `select
       sum(case when ${columnSql} is null then 1 else 0 end) as null_count,
       count(${columnSql}) as non_null_count
       ${isNumericDuckDbType(column.type) ? `, min(${columnSql}) as min_value, max(${columnSql}) as max_value, avg(${columnSql}) as mean_value` : ""}
     from ${view}`
  );
  const stats = (statsReader.getRowObjectsJson() as Array<Record<string, JsonValue>>)[0] ?? {};
  const topValues = topK === 0 ? [] : await readTopColumnValues(connection, viewName, column.name, topK);
  const profile: ParquetColumnProfile = {
    name: column.name,
    type: column.type,
    nullCount: Number(stats.null_count ?? 0),
    nonNullCount: Number(stats.non_null_count ?? 0),
    topValues,
  };

  if (isNumericDuckDbType(column.type)) {
    profile.numeric = {
      min: toNullableNumber(stats.min_value),
      max: toNullableNumber(stats.max_value),
      mean: toNullableNumber(stats.mean_value),
    };
  }

  return profile;
}

async function readTopColumnValues(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  viewName: string,
  columnName: string,
  topK: number
): Promise<ParquetColumnTopValue[]> {
  const column = sqlIdentifier(columnName);
  const reader = await connection.runAndReadAll(
    `select
       ${column} as value,
       count(*) as value_count
     from ${sqlIdentifier(viewName)}
     group by ${column}
     order by value_count desc, (${column} is null) asc, cast(${column} as varchar) asc
     limit ${topK}`
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  return rows.map((row) => ({
    value: row.value,
    count: Number(row.value_count ?? 0),
  }));
}

async function createDistributionUnitsView(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  input: {
    unitSql: string;
    valueColumn: string;
    weightColumn: string;
    groupColumn?: string;
  }
): Promise<void> {
  const value = sqlIdentifier(input.valueColumn);
  const weight = sqlIdentifier(input.weightColumn);
  const group =
    input.groupColumn === undefined ? "'__all__' as group_value" : `cast(${sqlIdentifier(input.groupColumn)} as varchar) as group_value`;

  await connection.run(
    `create or replace temp view ibge_distribution_units as
     select
       cast(${value} as double) as value,
       cast(${weight} as double) as weight,
       ${group}
     from (${input.unitSql}) as ibge_distribution_source
     where ${value} is not null
       and ${weight} is not null
       and cast(${weight} as double) > 0`
  );
}

interface DistributionTotals {
  rowsUsed: number;
  totalWeight: number;
  totalValue: number;
}

interface ValueBucket {
  value: number;
  weight: number;
  totalValue: number;
}

interface GroupBucket extends ValueBucket {
  groupValue: string;
}

async function readDistributionTotals(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>
): Promise<DistributionTotals> {
  const reader = await connection.runAndReadAll(
    `select
       count(*) as rows_used,
       coalesce(sum(weight), 0) as total_weight,
       coalesce(sum(weight * value), 0) as total_value
     from ibge_distribution_units`
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  return {
    rowsUsed: Number(rows[0]?.rows_used ?? 0),
    totalWeight: Number(rows[0]?.total_weight ?? 0),
    totalValue: Number(rows[0]?.total_value ?? 0),
  };
}

async function readValueBuckets(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>
): Promise<ValueBucket[]> {
  const reader = await connection.runAndReadAll(
    `select
       value,
       sum(weight) as weight,
       sum(weight * value) as total_value
     from ibge_distribution_units
     group by value
     order by value desc`
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  return rows.map((row) => ({
    value: Number(row.value),
    weight: Number(row.weight),
    totalValue: Number(row.total_value),
  }));
}

async function readGroupBuckets(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>
): Promise<GroupBucket[]> {
  const reader = await connection.runAndReadAll(
    `select
       value,
       group_value,
       sum(weight) as weight,
       sum(weight * value) as total_value
     from ibge_distribution_units
     group by value, group_value
     order by value desc, group_value asc`
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  return rows.map((row) => ({
    value: Number(row.value),
    groupValue: String(row.group_value),
    weight: Number(row.weight),
    totalValue: Number(row.total_value),
  }));
}

async function readGroupSummaries(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  totals: DistributionTotals,
  maxGroups: number
): Promise<{ groups: WeightedDistributionGroupSummary[]; truncated: boolean }> {
  const reader = await connection.runAndReadAll(
    `select
       group_value,
       sum(weight) as weight,
       sum(weight * value) as total_value
     from ibge_distribution_units
     group by group_value
     order by total_value desc, group_value asc
     limit ${maxGroups + 1}`
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, JsonValue>>;
  const truncated = rows.length > maxGroups;
  return {
    truncated,
    groups: rows.slice(0, maxGroups).map((row) => {
      const weight = Number(row.weight);
      const totalValue = Number(row.total_value);
      return {
        groupValue: String(row.group_value),
        weight,
        totalValue,
        populationShare: safeDivide(weight, totals.totalWeight) ?? 0,
        valueShare: safeDivide(totalValue, totals.totalValue),
        weightedMean: safeDivide(totalValue, weight),
      };
    }),
  };
}

function calculateTopBrackets(input: {
  valueBuckets: ValueBucket[];
  groupBuckets: GroupBucket[];
  totalWeight: number;
  totalValue: number;
  topPercents: number[];
}): WeightedDistributionTopBracket[] {
  return input.topPercents.map((percent) => {
    const thresholdWeight = input.totalWeight * percent;
    let remainingWeight = thresholdWeight;
    let includedWeight = 0;
    let includedValue = 0;
    let cutoffValue: number | null = null;
    const valueFactors = new Map<number, number>();

    for (const bucket of input.valueBuckets) {
      if (remainingWeight <= 0) break;
      const takenWeight = Math.min(bucket.weight, remainingWeight);
      if (takenWeight <= 0) continue;

      const factor = takenWeight / bucket.weight;
      valueFactors.set(bucket.value, factor);
      includedWeight += takenWeight;
      includedValue += bucket.totalValue * factor;
      cutoffValue = bucket.value;
      remainingWeight -= takenWeight;
    }

    return {
      percent,
      cutoffValue,
      thresholdWeight,
      weight: includedWeight,
      totalValue: includedValue,
      valueShare: safeDivide(includedValue, input.totalValue),
      weightedMean: safeDivide(includedValue, includedWeight),
      groups: calculateTopGroupSummaries({
        groupBuckets: input.groupBuckets,
        valueFactors,
        includedWeight,
        includedValue,
        totalValue: input.totalValue,
      }),
    };
  });
}

function calculateTopGroupSummaries(input: {
  groupBuckets: GroupBucket[];
  valueFactors: Map<number, number>;
  includedWeight: number;
  includedValue: number;
  totalValue: number;
}): WeightedDistributionTopGroupSummary[] {
  const groups = new Map<string, { weight: number; totalValue: number }>();

  for (const bucket of input.groupBuckets) {
    const factor = input.valueFactors.get(bucket.value);
    if (factor === undefined || factor <= 0) continue;

    const current = groups.get(bucket.groupValue) ?? { weight: 0, totalValue: 0 };
    current.weight += bucket.weight * factor;
    current.totalValue += bucket.totalValue * factor;
    groups.set(bucket.groupValue, current);
  }

  return [...groups.entries()]
    .map(([groupValue, summary]) => ({
      groupValue,
      weight: summary.weight,
      totalValue: summary.totalValue,
      populationShareWithinBracket: safeDivide(summary.weight, input.includedWeight) ?? 0,
      valueShareWithinBracket: safeDivide(summary.totalValue, input.includedValue),
      valueShareOfTotal: safeDivide(summary.totalValue, input.totalValue),
    }))
    .sort((left, right) => left.groupValue.localeCompare(right.groupValue));
}

function validateViews(views: QueryParquetView[]): QueryParquetView[] {
  if (views.length === 0) {
    throw new Error("At least one Parquet view is required");
  }

  const seen = new Set<string>();
  return views.map((view) => {
    if (!SQL_IDENTIFIER_PATTERN.test(view.name)) {
      throw new Error("View names must be SQL identifiers");
    }
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

function validateColumnIdentifier(column: string, fieldName: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(column)) {
    throw new Error(`${fieldName} must be a SQL identifier`);
  }
  return column;
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

function normalizeMaxRows(maxRows: number | undefined): number {
  if (maxRows === undefined) return DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error("maxRows must be a positive integer");
  }
  return Math.min(maxRows, MAX_ALLOWED_ROWS);
}

function normalizeSampleRows(sampleRows: number | undefined): number {
  if (sampleRows === undefined) return DEFAULT_SAMPLE_ROWS;
  if (!Number.isInteger(sampleRows) || sampleRows < 0) {
    throw new Error("sampleRows must be a non-negative integer");
  }
  return Math.min(sampleRows, MAX_SAMPLE_ROWS);
}

function normalizeProfileColumns(columns: string[] | undefined): string[] | undefined {
  if (columns === undefined) return undefined;
  if (columns.length === 0) {
    throw new Error("columns must contain at least one column when provided");
  }
  const uniqueColumns: string[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    const validColumn = validateColumnIdentifier(column, "columns");
    if (!seen.has(validColumn)) {
      seen.add(validColumn);
      uniqueColumns.push(validColumn);
    }
  }
  if (uniqueColumns.length > MAX_PROFILE_COLUMNS) {
    throw new Error(`columns is capped at ${MAX_PROFILE_COLUMNS} unique names`);
  }
  return uniqueColumns;
}

function normalizeProfileMaxColumns(maxColumns: number | undefined): number {
  if (maxColumns === undefined) return DEFAULT_PROFILE_MAX_COLUMNS;
  if (!Number.isInteger(maxColumns) || maxColumns <= 0) {
    throw new Error("maxColumns must be a positive integer");
  }
  return Math.min(maxColumns, MAX_PROFILE_COLUMNS);
}

function normalizeProfileTopK(topK: number | undefined): number {
  if (topK === undefined) return DEFAULT_PROFILE_TOP_K;
  if (!Number.isInteger(topK) || topK < 0) {
    throw new Error("topK must be a non-negative integer");
  }
  return Math.min(topK, MAX_PROFILE_TOP_K);
}

function normalizeTopPercents(topPercents: number[] | undefined): number[] {
  const percents = topPercents ?? DEFAULT_TOP_PERCENTS;
  if (percents.length === 0) {
    throw new Error("At least one top percent is required");
  }
  for (const percent of percents) {
    if (!Number.isFinite(percent) || percent <= 0 || percent > 1) {
      throw new Error("topPercents must be fractions greater than 0 and less than or equal to 1");
    }
  }
  return [...new Set(percents)];
}

function normalizeMaxGroups(maxGroups: number | undefined): number {
  if (maxGroups === undefined) return DEFAULT_MAX_GROUPS;
  if (!Number.isInteger(maxGroups) || maxGroups <= 0) {
    throw new Error("maxGroups must be a positive integer");
  }
  return Math.min(maxGroups, MAX_GROUPS);
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function isNumericDuckDbType(type: string): boolean {
  return /^(U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)\b/i.test(type);
}

function toNullableNumber(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
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
