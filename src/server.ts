import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  describeParquetViewsTool,
  discoverMicrodataTool,
  listFilesTool,
  listDirectoryTool,
  listSurveysTool,
  listCachedFilesTool,
  downloadFileTool,
  extractZipEntryTool,
  fixedWidthFileToParquetTool,
  fixedWidthZipToParquetTool,
  inspectLayoutTool,
  pnadcAnalyzeFileTool,
  pnadcAnalyzeZipTool,
  pofDictionaryManifestTool,
  pofZipRecordToParquetTool,
  profileParquetViewsTool,
  queryParquetTool,
  queryParquetViewsTool,
  remoteFileInfoTool,
  weightedDistributionTool,
  zipEntriesTool,
} from "./tools.js";

export const SERVER_NAME = "ibge-microdata-mcp-server";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const LOCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const listFilesSchema = z.object({
  survey: z
    .enum(["pnadc_trimestral", "pof"])
    .describe("Microdata family to list: pnadc_trimestral or pof."),
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .optional()
    .describe("Calendar year for PNAD Contínua quarterly files, e.g. 2024."),
});

const remoteInfoSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Official ftp.ibge.gov.br file URL to inspect with HTTP HEAD."),
});

const listDirectorySchema = z.object({
  url: z
    .string()
    .url()
    .describe("Official ftp.ibge.gov.br directory URL to list."),
});

const discoverMicrodataSchema = z.object({
  rootUrl: z
    .string()
    .url()
    .optional()
    .describe("Official ftp.ibge.gov.br directory URL where discovery should start. Defaults to the IBGE FTP root."),
  maxDepth: z
    .number()
    .int()
    .positive()
    .max(8)
    .optional()
    .describe("Maximum crawl depth from root. Defaults to 3 and is capped at 8."),
  maxDirectories: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Maximum number of directories to fetch. Defaults to 50 and is capped at 500."),
  includeDocumentation: z
    .boolean()
    .optional()
    .describe("Whether to include documentation, dictionary, layout, and input files in matches. Defaults to true."),
});

const inspectLayoutSchema = z.object({
  layoutPath: z
    .string()
    .min(1)
    .describe("Local path to an official IBGE SAS/TXT fixed-width input layout file."),
  search: z
    .string()
    .min(1)
    .optional()
    .describe("Optional case-insensitive search over variable names and descriptions."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum number of variables to return. Defaults to 200 and is capped at 1000."),
});

const downloadFileSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Official ftp.ibge.gov.br file URL to download."),
  cacheRoot: z
    .string()
    .min(1)
    .describe("Local cache root where the official IBGE URL path will be mirrored."),
});

const listCacheSchema = z.object({
  cacheRoot: z
    .string()
    .min(1)
    .describe("Local cache root previously used with ibge_microdata_download_file."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum cached files to return. Defaults to 50 and is capped at 1000."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of cached files to skip for pagination. Defaults to 0."),
});

const pnadcAnalyzeFileSchema = z.object({
  layoutPath: z
    .string()
    .min(1)
    .describe("Local path to the PNAD Contínua SAS/TXT input layout file."),
  dataPath: z
    .string()
    .min(1)
    .describe("Local path to an extracted PNAD Contínua fixed-width TXT microdata file."),
  topPercents: z
    .array(z.number().gt(0).lte(1))
    .optional()
    .describe("Top weighted-value brackets as fractions, e.g. [0.01, 0.05, 0.1]."),
});

const pnadcAnalyzeZipSchema = z.object({
  layoutPath: z
    .string()
    .min(1)
    .describe("Local path to the PNAD Contínua SAS/TXT input layout file."),
  zipPath: z
    .string()
    .min(1)
    .describe("Local path to a PNAD Contínua ZIP archive downloaded from IBGE."),
  entryName: z
    .string()
    .min(1)
    .optional()
    .describe("Exact ZIP entry name to analyze. If omitted, the first PNADC .txt entry is used."),
  topPercents: z
    .array(z.number().gt(0).lte(1))
    .optional()
    .describe("Top weighted-value brackets as fractions, e.g. [0.01, 0.05, 0.1]."),
});

const zipEntriesSchema = z.object({
  zipPath: z.string().min(1).describe("Local path to a ZIP archive downloaded from IBGE."),
});

const extractZipEntrySchema = z.object({
  zipPath: z.string().min(1).describe("Local path to a ZIP archive downloaded from IBGE."),
  entryName: z.string().min(1).describe("Exact ZIP entry name to extract."),
  outputPath: z.string().min(1).describe("Local destination path for the extracted entry."),
});

const fixedWidthFileToParquetSchema = z.object({
  layoutPath: z
    .string()
    .min(1)
    .describe("Local path to an official IBGE SAS/TXT input layout file."),
  dataPath: z
    .string()
    .min(1)
    .describe("Local path to an extracted fixed-width microdata TXT file."),
  outputPath: z
    .string()
    .min(1)
    .describe("Local destination path for the Parquet file to create."),
  selectedVariables: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional variable names to export. If omitted, all layout variables are exported."),
  rowLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional maximum number of non-empty rows to export, useful for smoke tests or previews."),
});

const fixedWidthZipToParquetSchema = z.object({
  layoutPath: z
    .string()
    .min(1)
    .describe("Local path to an official IBGE SAS/TXT input layout file."),
  zipPath: z
    .string()
    .min(1)
    .describe("Local path to a ZIP archive downloaded from IBGE."),
  entryName: z
    .string()
    .min(1)
    .describe("Exact fixed-width TXT entry name inside the ZIP archive."),
  outputPath: z
    .string()
    .min(1)
    .describe("Local destination path for the Parquet file to create."),
  selectedVariables: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional variable names to export. If omitted, all layout variables are exported."),
  rowLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional maximum number of non-empty rows to export, useful for smoke tests or previews."),
});

const queryParquetSchema = z.object({
  parquetPaths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Local Parquet file paths to expose as a DuckDB view named microdata."),
  sql: z
    .string()
    .min(1)
    .describe("Read-only SELECT or WITH query against the microdata view. Semicolons and write keywords are rejected."),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe("Maximum rows to return. Defaults to 1000 and is capped at 10000."),
});

const queryParquetViewsSchema = z.object({
  views: z
    .array(
      z.object({
        name: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .describe("SQL-safe view name, e.g. domicilio, morador, rendimento_trabalho."),
        parquetPaths: z
          .array(z.string().min(1))
          .min(1)
          .describe("Local Parquet file path(s) to expose under this view name."),
      })
    )
    .min(1)
    .describe("Named local Parquet views to create before running SQL."),
  sql: z
    .string()
    .min(1)
    .describe("Read-only SELECT or WITH query against the named views. Semicolons and write keywords are rejected."),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe("Maximum rows to return. Defaults to 1000 and is capped at 10000."),
});

const parquetViewSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe("SQL-safe view name, e.g. domicilio, morador, rendimento_trabalho."),
  parquetPaths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Local Parquet file path(s) to expose under this view name."),
});

const describeParquetViewsSchema = z.object({
  views: z
    .array(parquetViewSchema)
    .min(1)
    .describe("Named local Parquet views to inspect."),
  includeRowCounts: z
    .boolean()
    .optional()
    .describe("Whether to count rows in each view. Defaults to false."),
  sampleRows: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Number of sample rows to return per view. Defaults to 0 and is capped at 100."),
});

const profileParquetViewsSchema = z.object({
  views: z
    .array(parquetViewSchema)
    .min(1)
    .describe("Named local Parquet views to profile."),
  columns: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
    .min(1)
    .max(200)
    .optional()
    .describe("Optional specific column names to profile. If omitted, the first maxColumns columns are profiled."),
  maxColumns: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum columns to profile when columns is omitted. Defaults to 25 and is capped at 200."),
  topK: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Number of most frequent values to return per profiled column. Defaults to 5 and is capped at 50."),
  sampleRows: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Number of sample rows to return per view. Defaults to 0 and is capped at 100."),
});

const weightedDistributionSchema = z.object({
  views: z
    .array(parquetViewSchema)
    .min(1)
    .describe("Named local Parquet views to create before calculating the distribution."),
  unitSql: z
    .string()
    .min(1)
    .describe(
      "Read-only SELECT/WITH query that returns one row per analytical unit with value, weight, and optional group columns."
    ),
  valueColumn: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe("Column name from unitSql containing the income, consumption, wealth, or other value to rank."),
  weightColumn: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe("Column name from unitSql containing the survey/sample weight."),
  groupColumn: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional()
    .describe("Optional column name from unitSql used for group breakdowns, e.g. region or category."),
  topPercents: z
    .array(z.number().gt(0).lte(1))
    .optional()
    .describe("Top brackets as fractions, e.g. [0.01, 0.05, 0.1]. Defaults to [0.01, 0.05, 0.1]."),
  maxGroups: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum group summaries to return. Defaults to 100 and is capped at 1000."),
});

const pofDictionaryManifestSchema = z.object({
  dictionaryPath: z
    .string()
    .min(1)
    .describe("Local path to the POF Excel dictionary workbook, usually Dicionários de váriaveis.xls."),
  dataZipPath: z
    .string()
    .min(1)
    .optional()
    .describe("Optional local path to a POF Dados ZIP. If provided, dictionary records are matched against real ZIP entries."),
  search: z
    .string()
    .min(1)
    .optional()
    .describe("Optional case-insensitive search over POF variable names and descriptions."),
  variableLimit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum variables to return per record. Defaults to 50 and is capped at 1000."),
});

const pofZipRecordToParquetSchema = z.object({
  dictionaryPath: z
    .string()
    .min(1)
    .describe("Local path to the POF Excel dictionary workbook, usually Dicionários de váriaveis.xls."),
  zipPath: z
    .string()
    .min(1)
    .describe("Local path to the POF Dados ZIP archive downloaded from IBGE."),
  recordName: z
    .string()
    .min(1)
    .describe("POF record sheet name or known TXT entry name, e.g. Domicílio, Morador, Rendimento do Trabalho, DOMICILIO.txt."),
  outputPath: z
    .string()
    .min(1)
    .describe("Local destination path for the Parquet file to create."),
  selectedVariables: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional POF variable names to export. If omitted, all variables for the record are exported."),
  rowLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional maximum number of non-empty rows to export, useful for smoke tests or previews."),
});

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "ibge_microdata_list_surveys",
    {
      title: "List IBGE Microdata Surveys",
      description: `List the IBGE microdata families currently supported by this local-first MCP.

Use this first when deciding whether the server can help with PNAD Contínua, POF, or another IBGE microdata source.
This tool does not download data.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => toMcpResult(listSurveysTool())
  );

  server.registerTool(
    "ibge_microdata_list_files",
    {
      title: "List IBGE Microdata Files",
      description: `List official IBGE microdata download files for a supported survey.

For PNAD Contínua quarterly files, pass survey="pnadc_trimestral" and a year such as 2024.
For POF, pass survey="pof"; this returns known edition-level public archives for 2017-2018, 2008-2009, and 2002-2003.
This tool lists URLs only; it does not download large ZIP files.`,
      inputSchema: listFilesSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await listFilesTool(args))
  );

  server.registerTool(
    "ibge_microdata_list_directory",
    {
      title: "List Official IBGE Directory",
      description: `List downloadable files in any official ftp.ibge.gov.br directory.

Use this for IBGE microdata families that do not yet have a survey-specific convenience tool. It only lists links; it does not download file bodies.`,
      inputSchema: listDirectorySchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await listDirectoryTool(args))
  );

  server.registerTool(
    "ibge_microdata_discover",
    {
      title: "Discover Official IBGE Microdata Files",
      description: `Crawl official ftp.ibge.gov.br directories with strict limits to find public microdata directories, data ZIPs, and documentation/layout files.

Use this when a survey-specific convenience listing is not implemented yet. The tool only fetches directory pages; it does not download microdata archives.`,
      inputSchema: discoverMicrodataSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await discoverMicrodataTool(args))
  );

  server.registerTool(
    "ibge_microdata_inspect_layout",
    {
      title: "Inspect IBGE Fixed-Width Layout",
      description: `Parse a local official IBGE SAS/TXT input layout and return variable names, positions, widths, types, and descriptions.

Use this before converting fixed-width microdata to Parquet so you can choose selectedVariables without opening the full dictionary manually.`,
      inputSchema: inspectLayoutSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await inspectLayoutTool(args))
  );

  server.registerTool(
    "ibge_microdata_file_info",
    {
      title: "Inspect IBGE Microdata File",
      description: `Fetch HTTP HEAD metadata for an official IBGE microdata file URL.

Use this before downloading a large file to check its size, content type, update timestamp, and ETag.`,
      inputSchema: remoteInfoSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await remoteFileInfoTool(args))
  );

  server.registerTool(
    "ibge_microdata_download_file",
    {
      title: "Download IBGE Microdata File",
      description: `Download or reuse a selected official IBGE microdata file in a local cache path.

This is explicit and local-first: the tool mirrors the ftp.ibge.gov.br URL under cacheRoot, checks official HEAD content-length metadata, and skips re-downloading when a cached file has the expected byte size. Use ibge_microdata_file_info first for large files so the user understands size before downloading.`,
      inputSchema: downloadFileSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await downloadFileTool(args))
  );

  server.registerTool(
    "ibge_microdata_list_cache",
    {
      title: "List Local IBGE Cache",
      description: `List files already downloaded into a local IBGE microdata cache.

Use this after one or more ibge_microdata_download_file calls to rediscover local paths, original ftp.ibge.gov.br URLs, byte sizes, and modification timestamps without hitting IBGE again. The tool only reads the local cache and supports limit/offset pagination.`,
      inputSchema: listCacheSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await listCachedFilesTool(args))
  );

  server.registerTool(
    "ibge_microdata_pnadc_analyze_file",
    {
      title: "Analyze PNAD Contínua Text File",
      description: `Analyze an extracted PNAD Contínua fixed-width TXT file using the official SAS/TXT input layout.

This is a PNAD-specific convenience helper for a small predefined set of variables. For custom public workflows, prefer converting selected variables to Parquet and using the generic query or weighted-distribution tools.
Use it after downloading/extracting PNAD microdata locally when this predefined summary matches your task.`,
      inputSchema: pnadcAnalyzeFileSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await pnadcAnalyzeFileTool(args))
  );

  server.registerTool(
    "ibge_microdata_pnadc_analyze_zip",
    {
      title: "Analyze PNAD Contínua ZIP Entry",
      description: `Analyze a PNAD Contínua fixed-width TXT entry directly inside a local ZIP archive.

This is a PNAD-specific convenience helper for a small predefined set of variables and avoids extracting the full microdata TXT first. For custom public workflows, prefer converting selected variables to Parquet and using the generic query or weighted-distribution tools.
Use it after downloading a PNAD ZIP and extracting or otherwise providing the official input layout when this predefined summary matches your task.`,
      inputSchema: pnadcAnalyzeZipSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await pnadcAnalyzeZipTool(args))
  );

  server.registerTool(
    "ibge_microdata_zip_entries",
    {
      title: "List ZIP Entries",
      description: `List file entries inside a local IBGE ZIP archive without extracting the archive.

Use this after ibge_microdata_download_file to discover the exact TXT, documentation, or table names inside official IBGE microdata ZIPs.`,
      inputSchema: zipEntriesSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await zipEntriesTool(args))
  );

  server.registerTool(
    "ibge_microdata_extract_zip_entry",
    {
      title: "Extract ZIP Entry",
      description: `Extract one selected file from a local IBGE ZIP archive to a local path.

Use this to pull the PNAD fixed-width TXT file or the official input layout out of a downloaded ZIP without unpacking everything manually.`,
      inputSchema: extractZipEntrySchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await extractZipEntryTool(args))
  );

  server.registerTool(
    "ibge_microdata_fixed_width_file_to_parquet",
    {
      title: "Convert Fixed-Width IBGE File to Parquet",
      description: `Convert a local fixed-width IBGE microdata TXT file into a local Parquet file using an official SAS/TXT input layout.

This is the generic optimization path for repeated analysis: use it for PNAD, POF, or other IBGE microdata families that publish fixed-width TXT files and input layouts. Select only needed variables to keep Parquet files small.`,
      inputSchema: fixedWidthFileToParquetSchema.shape,
      annotations: LOCAL_WRITE,
    },
    async (args) => toMcpResult(await fixedWidthFileToParquetTool(args))
  );

  server.registerTool(
    "ibge_microdata_fixed_width_zip_to_parquet",
    {
      title: "Convert Fixed-Width IBGE ZIP Entry to Parquet",
      description: `Convert one fixed-width TXT entry inside a local IBGE ZIP archive into a local Parquet file using an official SAS/TXT input layout.

This avoids extracting the full TXT first, writes a local columnar file, and is useful before running repeated DuckDB queries over selected PNAD, POF, or other IBGE variables.`,
      inputSchema: fixedWidthZipToParquetSchema.shape,
      annotations: LOCAL_WRITE,
    },
    async (args) => toMcpResult(await fixedWidthZipToParquetTool(args))
  );

  server.registerTool(
    "ibge_microdata_query_parquet",
    {
      title: "Query Local IBGE Parquet",
      description: `Run a bounded read-only DuckDB SELECT/WITH query over local Parquet files.

The provided files are exposed as a view named microdata. Use this after converting IBGE fixed-width microdata to Parquet when you need repeated summaries, grouped tabulations, or weighted statistics without reparsing the original TXT files.`,
      inputSchema: queryParquetSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await queryParquetTool(args))
  );

  server.registerTool(
    "ibge_microdata_query_parquet_views",
    {
      title: "Query Named Local IBGE Parquet Views",
      description: `Run a bounded read-only DuckDB SELECT/WITH query over multiple named local Parquet views.

Use this for relational microdata workflows, especially POF, where separate records such as domicilio, morador, and rendimento_trabalho should be joined by their shared keys after conversion to Parquet.`,
      inputSchema: queryParquetViewsSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await queryParquetViewsTool(args))
  );

  server.registerTool(
    "ibge_microdata_weighted_distribution",
    {
      title: "Analyze Weighted IBGE Distribution",
      description: `Calculate weighted distribution summaries and top-bracket shares over local IBGE Parquet views.

Use this after converting microdata to Parquet when you need income, consumption, wealth, or other distribution statistics without hand-writing all aggregation SQL. Provide unitSql as a read-only SELECT/WITH query that returns a numeric value column, a numeric weight column, and optionally a group column. The tool ranks units by value, computes total weight/value/mean, group population and value shares, and top brackets such as top 1%, 5%, and 10%. Cutoff ties are allocated proportionally across groups.`,
      inputSchema: weightedDistributionSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await weightedDistributionTool(args))
  );

  server.registerTool(
    "ibge_microdata_describe_parquet_views",
    {
      title: "Describe Named Local IBGE Parquet Views",
      description: `Inspect local Parquet files as named DuckDB views and return columns, DuckDB types, optional row counts, and optional sample rows.

Use this before writing join queries over POF or other relational microdata records so the agent can see actual column names and types.`,
      inputSchema: describeParquetViewsSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await describeParquetViewsTool(args))
  );

  server.registerTool(
    "ibge_microdata_profile_parquet_views",
    {
      title: "Profile Named Local IBGE Parquet Views",
      description: `Profile local Parquet files as named DuckDB views and return bounded exploratory statistics.

Use this after converting IBGE fixed-width microdata to Parquet and before writing custom SQL. The tool reports row counts, column types, null/non-null counts, optional numeric min/max/mean, frequent values, and optional sample rows. By default it profiles the first 25 columns to keep exploration bounded; pass columns for a precise subset.`,
      inputSchema: profileParquetViewsSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await profileParquetViewsTool(args))
  );

  server.registerTool(
    "ibge_microdata_pof_manifest",
    {
      title: "Inspect POF Dictionary Manifest",
      description: `Parse the POF Excel variable dictionary and return record sheets, mapped TXT data entries, record lengths, and variable layouts.

Use this after downloading/extracting the POF documentation ZIP to understand which POF record to convert and which variables to select.`,
      inputSchema: pofDictionaryManifestSchema.shape,
      annotations: READ_ONLY,
    },
    async (args) => toMcpResult(await pofDictionaryManifestTool(args))
  );

  server.registerTool(
    "ibge_microdata_pof_zip_record_to_parquet",
    {
      title: "Convert POF ZIP Record to Parquet",
      description: `Convert one POF fixed-width TXT record inside a local Dados ZIP into Parquet using the POF Excel dictionary workbook.

This is the POF-specific optimized path: it understands POF record sheets, maps them to ZIP entries such as DOMICILIO.txt or RENDIMENTO_TRABALHO.txt, applies implied decimal scaling, and writes a local Parquet file for DuckDB queries.`,
      inputSchema: pofZipRecordToParquetSchema.shape,
      annotations: LOCAL_WRITE,
    },
    async (args) => toMcpResult(await pofZipRecordToParquetTool(args))
  );

  return server;
}

function toMcpResult<T>(result: { markdown: string; structured: T }) {
  return {
    content: [{ type: "text" as const, text: result.markdown }],
    structuredContent: result.structured as Record<string, unknown>,
  };
}
