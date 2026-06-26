import {
  downloadRemoteFile,
  fetchDirectoryEntries,
  getRemoteFileInfo,
  type DownloadRemoteFileOutput,
  type RemoteFileInfo,
} from "./http.js";
import {
  listCachedFiles,
  type ListCachedFilesOutput,
} from "./cache.js";
import {
  listSupportedSurveys,
  PNADC_TRIMESTRAL_MICRODATA_URL,
  type DirectoryEntry,
  type SurveyId,
  type SupportedSurvey,
} from "./catalog.js";
import {
  discoverMicrodataFiles,
  type DiscoverMicrodataOutput,
} from "./discovery.js";
import { inspectLayout, type InspectLayoutOutput } from "./layout-inspect.js";
import { summarizePnadcTextFile, type SummarizePnadcTextFileOutput } from "./pnadc-file.js";
import { summarizePnadcZipFile, type SummarizePnadcZipFileOutput } from "./pnadc-zip.js";
import {
  exportPofZipRecordToParquet,
  readPofDictionaryManifest,
  type PofDictionaryManifest,
} from "./pof.js";
import {
  exportFixedWidthFileToParquet,
  exportFixedWidthZipEntryToParquet,
  type FixedWidthParquetOutput,
} from "./fixed-width-parquet.js";
import {
  describeParquetViews,
  profileParquetViews,
  queryParquetFiles,
  queryParquetViews,
  weightedDistributionFromParquetViews,
  type DescribeParquetViewsOutput,
  type ProfileParquetViewsInput,
  type ProfileParquetViewsOutput,
  type QueryParquetOutput,
  type QueryParquetViewsOutput,
  type WeightedDistributionInput,
  type WeightedDistributionOutput,
} from "./parquet-query.js";
import {
  extractZipEntry,
  listZipEntries,
  type ExtractZipEntryResult,
  type ZipEntryInfo,
} from "./zip.js";

export interface ToolResult<T> {
  markdown: string;
  structured: T;
}

export interface ListSurveysOutput {
  total: number;
  surveys: SupportedSurvey[];
}

export interface ListFilesInput {
  survey: SurveyId;
  year?: number;
}

export interface ListFilesOutput {
  survey: SurveyId;
  sourceUrl: string;
  files: DirectoryEntry[];
}

export interface ListDirectoryInput {
  url: string;
}

export interface ListDirectoryOutput {
  sourceUrl: string;
  files: DirectoryEntry[];
}

export interface DiscoverMicrodataToolInput {
  rootUrl?: string;
  maxDepth?: number;
  maxDirectories?: number;
  includeDocumentation?: boolean;
}

export interface InspectLayoutToolInput {
  layoutPath: string;
  search?: string;
  limit?: number;
}

export interface RemoteFileInfoInput {
  url: string;
}

export interface RemoteFileInfoOutput {
  info: RemoteFileInfo;
}

export interface DownloadFileInput {
  url: string;
  cacheRoot: string;
}

export interface ListCachedFilesToolInput {
  cacheRoot: string;
  limit?: number;
  offset?: number;
}

export interface PnadcAnalyzeFileInput {
  layoutPath: string;
  dataPath: string;
  topPercents?: number[];
}

export interface PnadcAnalyzeZipInput {
  layoutPath: string;
  zipPath: string;
  entryName?: string;
  topPercents?: number[];
}

export interface ZipEntriesInput {
  zipPath: string;
}

export interface ZipEntriesOutput {
  zipPath: string;
  entries: ZipEntryInfo[];
}

export interface ExtractZipEntryInput {
  zipPath: string;
  entryName: string;
  outputPath: string;
}

export interface FixedWidthFileToParquetInput {
  layoutPath: string;
  dataPath: string;
  outputPath: string;
  selectedVariables?: string[];
  rowLimit?: number;
}

export interface FixedWidthZipToParquetInput {
  layoutPath: string;
  zipPath: string;
  entryName: string;
  outputPath: string;
  selectedVariables?: string[];
  rowLimit?: number;
}

export interface QueryParquetToolInput {
  parquetPaths: string[];
  sql: string;
  maxRows?: number;
}

export interface QueryParquetViewsToolInput {
  views: Array<{
    name: string;
    parquetPaths: string[];
  }>;
  sql: string;
  maxRows?: number;
}

export interface DescribeParquetViewsToolInput {
  views: Array<{
    name: string;
    parquetPaths: string[];
  }>;
  includeRowCounts?: boolean;
  sampleRows?: number;
}

export type ProfileParquetViewsToolInput = ProfileParquetViewsInput;

export type WeightedDistributionToolInput = WeightedDistributionInput;

export interface PofDictionaryManifestToolInput {
  dictionaryPath: string;
  dataZipPath?: string;
  search?: string;
  variableLimit?: number;
}

export interface PofZipRecordToParquetToolInput {
  dictionaryPath: string;
  zipPath: string;
  recordName: string;
  outputPath: string;
  selectedVariables?: string[];
  rowLimit?: number;
}

export function listSurveysTool(): ToolResult<ListSurveysOutput> {
  const surveys = listSupportedSurveys();
  return {
    markdown: [
      "# IBGE Microdata Survey Families",
      "",
      ...surveys.map((survey) => `- **${survey.name}** (\`${survey.id}\`): ${survey.description}`),
    ].join("\n"),
    structured: { total: surveys.length, surveys },
  };
}

export async function listFilesTool(input: ListFilesInput): Promise<ToolResult<ListFilesOutput>> {
  if (input.survey === "pnadc_trimestral") {
    if (!input.year) {
      throw new Error("year is required when survey='pnadc_trimestral'");
    }
    const sourceUrl = `${PNADC_TRIMESTRAL_MICRODATA_URL}${input.year}/`;
    const files = await fetchDirectoryEntries(sourceUrl);
    return {
      markdown: formatFilesMarkdown("PNAD Contínua Trimestral", sourceUrl, files),
      structured: { survey: input.survey, sourceUrl, files },
    };
  }

  const sourceUrl = "https://ftp.ibge.gov.br/Orcamentos_Familiares/";
  const files = pofMicrodataArchives();
  return {
    markdown: formatFilesMarkdown("Pesquisa de Orçamentos Familiares", sourceUrl, files),
    structured: { survey: input.survey, sourceUrl, files },
  };
}

export async function listDirectoryTool(
  input: ListDirectoryInput
): Promise<ToolResult<ListDirectoryOutput>> {
  assertOfficialIbgeUrl(input.url);
  const files = await fetchDirectoryEntries(input.url);
  return {
    markdown: formatFilesMarkdown("IBGE Download Directory", input.url, files),
    structured: { sourceUrl: input.url, files },
  };
}

export async function discoverMicrodataTool(
  input: DiscoverMicrodataToolInput
): Promise<ToolResult<DiscoverMicrodataOutput>> {
  const result = await discoverMicrodataFiles(input);
  return {
    markdown: formatDiscoveryMarkdown(result),
    structured: result,
  };
}

export async function inspectLayoutTool(input: InspectLayoutToolInput): Promise<ToolResult<InspectLayoutOutput>> {
  const result = await inspectLayout(input);
  return {
    markdown: formatInspectLayoutMarkdown(result),
    structured: result,
  };
}

export async function remoteFileInfoTool(
  input: RemoteFileInfoInput
): Promise<ToolResult<RemoteFileInfoOutput>> {
  const info = await getRemoteFileInfo(input.url);
  return {
    markdown: [
      "# IBGE Microdata File Metadata",
      "",
      `- URL: ${info.url}`,
      `- Size: ${info.contentLength === null ? "unknown" : `${info.contentLength} bytes`}`,
      `- Type: ${info.contentType ?? "unknown"}`,
      `- Last modified: ${info.lastModified ?? "unknown"}`,
      `- ETag: ${info.etag ?? "unknown"}`,
    ].join("\n"),
    structured: { info },
  };
}

export async function downloadFileTool(
  input: DownloadFileInput
): Promise<ToolResult<DownloadRemoteFileOutput>> {
  const result = await downloadRemoteFile(input);
  const title =
    result.cacheStatus === "hit" ? "# Cached IBGE Microdata File" : "# Downloaded IBGE Microdata File";
  return {
    markdown: [
      title,
      "",
      `URL: ${result.url}`,
      `Local path: ${result.path}`,
      `Cache status: ${result.cacheStatus}`,
      `Bytes: ${result.bytesWritten}`,
      `Type: ${result.contentType ?? "unknown"}`,
    ].join("\n"),
    structured: result,
  };
}

export async function listCachedFilesTool(
  input: ListCachedFilesToolInput
): Promise<ToolResult<ListCachedFilesOutput>> {
  const result = await listCachedFiles(input);
  return {
    markdown: formatCacheMarkdown(result),
    structured: result,
  };
}

export async function pnadcAnalyzeFileTool(
  input: PnadcAnalyzeFileInput
): Promise<ToolResult<SummarizePnadcTextFileOutput>> {
  const result = await summarizePnadcTextFile({
    layoutPath: input.layoutPath,
    dataPath: input.dataPath,
    topPercents: input.topPercents ?? [0.01, 0.05, 0.1],
  });
  return {
    markdown: formatPnadcSummaryMarkdown(result),
    structured: result,
  };
}

export async function pnadcAnalyzeZipTool(
  input: PnadcAnalyzeZipInput
): Promise<ToolResult<SummarizePnadcZipFileOutput>> {
  const result = await summarizePnadcZipFile({
    layoutPath: input.layoutPath,
    zipPath: input.zipPath,
    entryName: input.entryName,
    topPercents: input.topPercents ?? [0.01, 0.05, 0.1],
  });
  return {
    markdown: formatPnadcSummaryMarkdown(result, [`ZIP entry: ${result.zipEntryName}`]),
    structured: result,
  };
}

export async function zipEntriesTool(input: ZipEntriesInput): Promise<ToolResult<ZipEntriesOutput>> {
  const entries = await listZipEntries(input.zipPath);
  return {
    markdown: [
      "# ZIP Entries",
      "",
      `Archive: ${input.zipPath}`,
      "",
      ...entries.map(
        (entry) =>
          `- **${entry.fileName}**: ${entry.uncompressedSize} bytes uncompressed, ${entry.compressedSize} bytes compressed`
      ),
    ].join("\n"),
    structured: { zipPath: input.zipPath, entries },
  };
}

export async function extractZipEntryTool(
  input: ExtractZipEntryInput
): Promise<ToolResult<ExtractZipEntryResult>> {
  const result = await extractZipEntry(input.zipPath, input.entryName, input.outputPath);
  return {
    markdown: [
      "# Extracted ZIP Entry",
      "",
      `Extracted: ${result.fileName}`,
      `Output path: ${result.outputPath}`,
      `Bytes: ${result.bytesWritten}`,
    ].join("\n"),
    structured: result,
  };
}

export async function fixedWidthFileToParquetTool(
  input: FixedWidthFileToParquetInput
): Promise<ToolResult<FixedWidthParquetOutput>> {
  const result = await exportFixedWidthFileToParquet(input);
  return {
    markdown: formatParquetExportMarkdown(result),
    structured: result,
  };
}

export async function fixedWidthZipToParquetTool(
  input: FixedWidthZipToParquetInput
): Promise<ToolResult<FixedWidthParquetOutput>> {
  const result = await exportFixedWidthZipEntryToParquet(input);
  return {
    markdown: formatParquetExportMarkdown(result),
    structured: result,
  };
}

export async function queryParquetTool(input: QueryParquetToolInput): Promise<ToolResult<QueryParquetOutput>> {
  const result = await queryParquetFiles(input);
  return {
    markdown: formatParquetQueryMarkdown(result),
    structured: result,
  };
}

export async function queryParquetViewsTool(
  input: QueryParquetViewsToolInput
): Promise<ToolResult<QueryParquetViewsOutput>> {
  const result = await queryParquetViews(input);
  return {
    markdown: formatParquetViewsQueryMarkdown(result),
    structured: result,
  };
}

export async function weightedDistributionTool(
  input: WeightedDistributionToolInput
): Promise<ToolResult<WeightedDistributionOutput>> {
  const result = await weightedDistributionFromParquetViews(input);
  return {
    markdown: formatWeightedDistributionMarkdown(result),
    structured: result,
  };
}

export async function describeParquetViewsTool(
  input: DescribeParquetViewsToolInput
): Promise<ToolResult<DescribeParquetViewsOutput>> {
  const result = await describeParquetViews(input);
  return {
    markdown: formatParquetViewSchemaMarkdown(result),
    structured: result,
  };
}

export async function profileParquetViewsTool(
  input: ProfileParquetViewsToolInput
): Promise<ToolResult<ProfileParquetViewsOutput>> {
  const result = await profileParquetViews(input);
  return {
    markdown: formatParquetViewProfileMarkdown(result),
    structured: result,
  };
}

export async function pofDictionaryManifestTool(
  input: PofDictionaryManifestToolInput
): Promise<ToolResult<PofDictionaryManifest>> {
  const result = await readPofDictionaryManifest(input);
  return {
    markdown: formatPofManifestMarkdown(result),
    structured: result,
  };
}

export async function pofZipRecordToParquetTool(
  input: PofZipRecordToParquetToolInput
): Promise<ToolResult<FixedWidthParquetOutput>> {
  const result = await exportPofZipRecordToParquet(input);
  return {
    markdown: formatParquetExportMarkdown(result),
    structured: result,
  };
}

function formatFilesMarkdown(title: string, sourceUrl: string, files: DirectoryEntry[]): string {
  const lines = [`# ${title} Microdata Files`, "", `Source: ${sourceUrl}`, ""];
  for (const file of files) {
    lines.push(`- **${file.name}** (${file.kind}): ${file.url}`);
  }
  return lines.join("\n");
}

function formatDiscoveryMarkdown(result: DiscoverMicrodataOutput): string {
  const lines = [
    "# IBGE Microdata Discovery",
    "",
    `Root: ${result.rootUrl}`,
    `Directories visited: ${result.directoriesVisited}`,
    `Truncated: ${result.truncated ? "yes" : "no"}`,
    `Matches: ${result.matches.length}`,
    "",
  ];

  for (const match of result.matches) {
    lines.push(
      `- **${match.name}** (${match.kind}, depth ${match.depth}): ${match.url} [${match.matchedBecause.join(", ")}]`
    );
  }

  return lines.join("\n");
}

function formatInspectLayoutMarkdown(result: InspectLayoutOutput): string {
  const lines = [
    "# IBGE Fixed-Width Layout Variables",
    "",
    `Layout: ${result.layoutPath}`,
    `Total variables: ${result.totalVariables}`,
    `Returned variables: ${result.returnedVariables}`,
    "",
  ];

  for (const variable of result.variables) {
    lines.push(
      `- **${variable.name}** (${variable.type}, start ${variable.start}, width ${variable.width}): ${variable.description}`
    );
  }

  return lines.join("\n");
}

function formatPofManifestMarkdown(result: PofDictionaryManifest): string {
  const lines = [
    "# POF Dictionary Manifest",
    "",
    `Dictionary: ${result.dictionaryPath}`,
    `Data ZIP: ${result.dataZipPath ?? "not provided"}`,
    `Records: ${result.recordCount}`,
    "",
  ];

  for (const record of result.records) {
    lines.push(
      `- **${record.sheetName}** -> ${record.dataEntryName ?? "unmapped"}: ${record.variableCount} variables, record length ${record.recordLength}`
    );
    for (const variable of record.variables) {
      lines.push(
        `  - ${variable.name} (${variable.type}, start ${variable.start}, width ${variable.width}, decimals ${variable.decimals}): ${variable.description}`
      );
    }
  }

  return lines.join("\n");
}

function formatParquetExportMarkdown(result: FixedWidthParquetOutput): string {
  return [
    "# Exported IBGE Fixed-Width Microdata to Parquet",
    "",
    `Source: ${result.sourceName}`,
    `Output path: ${result.outputPath}`,
    `Rows read: ${result.rowsRead}`,
    `Rows written: ${result.rowsWritten}`,
    `Variables: ${result.variables.map((variable) => variable.name).join(", ")}`,
  ].join("\n");
}

function formatParquetQueryMarkdown(result: QueryParquetOutput): string {
  const preview = JSON.stringify(result.rows, null, 2);
  return [
    "# Parquet Query Result",
    "",
    `Rows returned: ${result.rowCount}`,
    `Truncated: ${result.truncated ? "yes" : "no"}`,
    `Files: ${result.parquetPaths.join(", ")}`,
    "",
    "```json",
    preview,
    "```",
  ].join("\n");
}

function formatParquetViewsQueryMarkdown(result: QueryParquetViewsOutput): string {
  const preview = JSON.stringify(result.rows, null, 2);
  return [
    "# Parquet Views Query Result",
    "",
    `Rows returned: ${result.rowCount}`,
    `Truncated: ${result.truncated ? "yes" : "no"}`,
    `Views: ${result.views.map((view) => `${view.name}=${view.parquetPaths.join("+")}`).join(", ")}`,
    "",
    "```json",
    preview,
    "```",
  ].join("\n");
}

function formatCacheMarkdown(result: ListCachedFilesOutput): string {
  const lines = [
    "# IBGE Local Cache",
    "",
    `Cache root: ${result.cacheRoot}`,
    `Total files: ${result.total}`,
    `Returned files: ${result.count}`,
    `Offset: ${result.offset}`,
    `Has more: ${result.hasMore ? "yes" : "no"}`,
  ];

  if (result.nextOffset !== undefined) {
    lines.push(`Next offset: ${result.nextOffset}`);
  }

  lines.push("");
  for (const file of result.files) {
    lines.push(`- **${file.relativePath}**: ${file.bytes} bytes, modified ${file.modifiedAt}`);
    lines.push(`  - ${file.url}`);
    lines.push(`  - ${file.path}`);
  }

  return lines.join("\n");
}

function formatWeightedDistributionMarkdown(result: WeightedDistributionOutput): string {
  const lines = [
    "# Weighted Distribution Summary",
    "",
    `Rows used: ${result.rowsUsed}`,
    `Distinct values: ${result.distinctValues}`,
    `Total weight: ${round(result.totalWeight)}`,
    `Total value: ${round(result.totalValue)}`,
    `Weighted mean: ${result.weightedMean === null ? "n/a" : round(result.weightedMean)}`,
  ];

  if (result.groups.length > 0) {
    lines.push("", "## Groups");
    for (const group of result.groups) {
      lines.push(
        `- **${group.groupValue}**: weight=${round(group.weight)}, population_share=${round(
          group.populationShare
        )}, value_share=${group.valueShare === null ? "n/a" : round(group.valueShare)}, weighted_mean=${
          group.weightedMean === null ? "n/a" : round(group.weightedMean)
        }`
      );
    }
    if (result.groupsTruncated) {
      lines.push("- Group list truncated; increase maxGroups to inspect more groups.");
    }
  }

  lines.push("", "## Top Brackets");
  for (const bracket of result.topBrackets) {
    lines.push(
      `- **Top ${round(bracket.percent * 100)}%**: cutoff=${bracket.cutoffValue ?? "n/a"}, weight=${round(
        bracket.weight
      )}, value_share=${bracket.valueShare === null ? "n/a" : round(bracket.valueShare)}`
    );
    for (const group of bracket.groups) {
      lines.push(
        `  - ${group.groupValue}: population_share_within_bracket=${round(
          group.populationShareWithinBracket
        )}, value_share_within_bracket=${
          group.valueShareWithinBracket === null ? "n/a" : round(group.valueShareWithinBracket)
        }`
      );
    }
  }

  return lines.join("\n");
}

function formatParquetViewSchemaMarkdown(result: DescribeParquetViewsOutput): string {
  const lines = ["# Parquet View Schema", ""];

  for (const view of result.views) {
    lines.push(`## ${view.name}`, `Files: ${view.parquetPaths.join(", ")}`);
    if (view.rowCount !== undefined) lines.push(`Rows: ${view.rowCount}`);
    lines.push("Columns:");
    for (const column of view.columns) {
      lines.push(`- ${column.name}: ${column.type}`);
    }
    if (view.sampleRows.length > 0) {
      lines.push("", "Sample:", "```json", JSON.stringify(view.sampleRows, null, 2), "```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatParquetViewProfileMarkdown(result: ProfileParquetViewsOutput): string {
  const lines = ["# Parquet View Profile", ""];

  for (const view of result.views) {
    lines.push(
      `## ${view.name}`,
      `Files: ${view.parquetPaths.join(", ")}`,
      `Rows: ${view.rowCount}`,
      `Columns profiled: ${view.profiledColumns} of ${view.totalColumns}${view.columnsTruncated ? " (truncated)" : ""}`,
      ""
    );

    for (const column of view.columns) {
      const numeric =
        column.numeric === undefined
          ? ""
          : `, min=${column.numeric.min ?? "n/a"}, max=${column.numeric.max ?? "n/a"}, mean=${
              column.numeric.mean === null ? "n/a" : round(column.numeric.mean)
            }`;
      lines.push(
        `- **${column.name}** (${column.type}): nulls=${column.nullCount}, non_null=${column.nonNullCount}${numeric}`
      );
      if (column.topValues.length > 0) {
        lines.push(`  - top_values=${JSON.stringify(column.topValues)}`);
      }
    }

    if (view.sampleRows.length > 0) {
      lines.push("", "Sample:", "```json", JSON.stringify(view.sampleRows, null, 2), "```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatPnadcSummaryMarkdown(
  result: SummarizePnadcTextFileOutput | SummarizePnadcZipFileOutput,
  contextLines: string[] = []
): string {
  const lines = [
    "# PNAD Contínua Income Group Summary",
    "",
  ];

  if (contextLines.length > 0) {
    lines.push(...contextLines, "");
  }

  lines.push(
    `Rows read: ${result.rowsRead}`,
    `Rows used: ${result.rowsUsed}`,
    `Weighted population: ${result.summary.totalWeight}`,
    "",
    "## Groups"
  );

  for (const [group, summary] of Object.entries(result.summary.groups)) {
    lines.push(
      `- **${group}**: weight=${round(summary.weight)}, population_share=${round(
        summary.populationShare
      )}, mean_income=${summary.meanIncome === null ? "n/a" : round(summary.meanIncome)}`
    );
  }

  lines.push("", "## Top Brackets");
  for (const [bracket, summary] of Object.entries(result.summary.topBrackets)) {
    lines.push(`- **${bracket}** cutoff=${summary.cutoffIncome ?? "n/a"}`);
    for (const [group, share] of Object.entries(summary.groupWeightShares)) {
      lines.push(`  - ${group}: ${round(share)}`);
    }
  }
  return lines.join("\n");
}

function pofMicrodataArchives(): DirectoryEntry[] {
  return [
    pofFile("POF 2017-2018 Dados", "Pesquisa_de_Orcamentos_Familiares_2017_2018/Microdados/Dados_20230713.zip"),
    pofFile(
      "POF 2017-2018 Documentacao",
      "Pesquisa_de_Orcamentos_Familiares_2017_2018/Microdados/Documentacao_20230713.zip"
    ),
    pofFile("POF 2008-2009 Dados", "Pesquisa_de_Orcamentos_Familiares_2008_2009/Microdados/Dados_20231009.zip"),
    pofFile(
      "POF 2008-2009 Documentacao",
      "Pesquisa_de_Orcamentos_Familiares_2008_2009/Microdados/Documentacao_20231009.zip"
    ),
    pofFile("POF 2002-2003 Dados", "Pesquisa_de_Orcamentos_Familiares_2002_2003/Microdados/Dados.zip"),
    pofFile("POF 2002-2003 Documentacao", "Pesquisa_de_Orcamentos_Familiares_2002_2003/Microdados/Documentacao.zip"),
  ];
}

function pofFile(name: string, suffix: string): DirectoryEntry {
  return {
    name,
    url: `https://ftp.ibge.gov.br/Orcamentos_Familiares/${suffix}`,
    kind: "file",
  };
}

function assertOfficialIbgeUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.hostname !== "ftp.ibge.gov.br") {
    throw new Error("Only ftp.ibge.gov.br directory URLs are supported");
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
