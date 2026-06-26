import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { JsonValue } from "./parquet-query.js";

const execFileAsync = promisify(execFile);

export type RunRScript = (script: string, inputJson: string, rscriptBin: string) => Promise<string>;

interface RBridgeOptions {
  rscriptBin?: string;
  runRScript?: RunRScript;
}

export interface RPackageStatus {
  name: string;
  installed: boolean;
  version: string | null;
}

export interface RRuntimeStatus {
  ok: boolean;
  rscriptBin: string;
  rVersion: string | null;
  packages: RPackageStatus[];
  missingPackages: string[];
}

export interface CheckRRuntimeInput extends RBridgeOptions {
  packages?: string[];
}

export interface DownloadPnadcWithRInput extends RBridgeOptions {
  year: number;
  quarter?: number;
  interview?: number;
  topic?: number;
  vars?: string[];
  outputPath: string;
  outputFormat?: "parquet" | "rds";
  selected?: boolean;
  labels?: boolean;
  deflator?: boolean;
  design?: boolean;
  reload?: boolean;
  savedir?: string;
  defyear?: number;
  defperiod?: number;
}

export interface RFileInfo {
  path: string;
  relativePath?: string;
  bytes: number;
}

export interface PnadcRDownloadOutput {
  backend: "PNADcIBGE";
  year: number;
  quarter?: number;
  interview?: number;
  topic?: number;
  outputPath: string;
  outputFormat: "parquet" | "rds";
  rows: number | null;
  columns: string[];
  packageVersions: Record<string, string>;
}

export interface LoadDatazoomPnadcWithRInput extends RBridgeOptions {
  outputDir: string;
  years: number[];
  quarters?: number[];
  panel?: DatazoomPanelMode;
  rawData?: boolean;
  outputFormat?: "parquet" | "csv";
  saveQuarterly?: boolean;
  vars?: string[];
}

export type DatazoomPanelMode = "none" | "basic" | "advanced" | "advanced_1" | "advanced_2" | "advanced_3";

export interface DatazoomPnadcLoadOutput {
  backend: "datazoom.social";
  outputDir: string;
  years: number[];
  quarters: number[];
  panel: DatazoomPanelMode;
  rawData: boolean;
  outputFormat: "parquet" | "csv";
  saveQuarterly: boolean;
  files: RFileInfo[];
  packageVersions: Record<string, string>;
}

const DEFAULT_RSCRIPT_BIN = "Rscript";
const DEFAULT_R_PACKAGES = ["PNADcIBGE", "datazoom.social", "survey", "jsonlite", "arrow"];
const MAX_R_STDOUT_BYTES = 50 * 1024 * 1024;

export async function checkRRuntime(input: CheckRRuntimeInput = {}): Promise<RRuntimeStatus> {
  const packages = input.packages ?? DEFAULT_R_PACKAGES;
  const response = await runRBridge(
    {
      action: "status",
      packages,
    },
    input
  );
  const packageStatuses = asPackageStatuses(response.packages);
  return {
    ok: packageStatuses.every((packageStatus) => packageStatus.installed),
    rscriptBin: input.rscriptBin ?? DEFAULT_RSCRIPT_BIN,
    rVersion: asNullableString(response.r_version),
    packages: packageStatuses,
    missingPackages: packageStatuses
      .filter((packageStatus) => !packageStatus.installed)
      .map((packageStatus) => packageStatus.name),
  };
}

export async function downloadPnadcWithR(input: DownloadPnadcWithRInput): Promise<PnadcRDownloadOutput> {
  validatePnadcDownloadInput(input);
  const outputFormat = input.outputFormat ?? inferPnadcOutputFormat(input.outputPath);
  if (outputFormat === "parquet" && input.design === true) {
    throw new Error("PNADcIBGE Parquet output requires design=false because survey design objects are not rectangular.");
  }

  const response = await runRBridge(
    {
      action: "pnadc_get",
      year: input.year,
      ...(input.quarter === undefined ? {} : { quarter: input.quarter }),
      ...(input.interview === undefined ? {} : { interview: input.interview }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      vars: input.vars ?? [],
      output_path: input.outputPath,
      output_format: outputFormat,
      selected: input.selected ?? (input.vars !== undefined && input.vars.length > 0),
      labels: input.labels ?? true,
      deflator: input.deflator ?? true,
      design: input.design ?? false,
      reload: input.reload ?? true,
      savedir: input.savedir ?? null,
      defyear: input.defyear ?? null,
      defperiod: input.defperiod ?? null,
    },
    input
  );
  const quarter = asOptionalNumber(response.quarter);
  const interview = asOptionalNumber(response.interview);
  const topic = asOptionalNumber(response.topic);

  return {
    backend: "PNADcIBGE",
    year: asNumber(response.year) ?? input.year,
    ...(quarter === undefined ? {} : { quarter }),
    ...(interview === undefined ? {} : { interview }),
    ...(topic === undefined ? {} : { topic }),
    outputPath: asString(response.output_path) ?? input.outputPath,
    outputFormat,
    rows: asNumber(response.rows),
    columns: asStringArray(response.columns),
    packageVersions: asStringRecord(response.package_versions),
  };
}

export async function loadDatazoomPnadcWithR(
  input: LoadDatazoomPnadcWithRInput
): Promise<DatazoomPnadcLoadOutput> {
  validateDatazoomInput(input);
  const quarters = input.quarters ?? [1, 2, 3, 4];
  const panel = input.panel ?? "advanced_3";
  const outputFormat = input.outputFormat ?? "parquet";
  const saveQuarterly = input.saveQuarterly ?? false;
  const rawData = input.rawData ?? false;

  const response = await runRBridge(
    {
      action: "datazoom_load_pnadc",
      output_dir: input.outputDir,
      years: input.years,
      quarters,
      panel,
      raw_data: rawData,
      output_format: outputFormat,
      save_quarterly: saveQuarterly,
      vars: input.vars ?? [],
    },
    input
  );

  return {
    backend: "datazoom.social",
    outputDir: asString(response.output_dir) ?? input.outputDir,
    years: asNumberArray(response.years),
    quarters: asNumberArray(response.quarters),
    panel: (asString(response.panel) as DatazoomPanelMode | undefined) ?? panel,
    rawData: asBoolean(response.raw_data) ?? rawData,
    outputFormat: (asString(response.output_format) as DatazoomPnadcLoadOutput["outputFormat"] | undefined) ?? outputFormat,
    saveQuarterly: asBoolean(response.save_quarterly) ?? saveQuarterly,
    files: asFileInfos(response.files),
    packageVersions: asStringRecord(response.package_versions),
  };
}

async function runRBridge(
  payload: Record<string, JsonValue | JsonValue[] | Record<string, JsonValue>>,
  options: RBridgeOptions
): Promise<Record<string, unknown>> {
  const rscriptBin = options.rscriptBin ?? DEFAULT_RSCRIPT_BIN;
  const runRScript = options.runRScript ?? defaultRunRScript;
  const stdout = await runRScript(R_BRIDGE_SCRIPT, JSON.stringify(payload), rscriptBin);
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`R bridge returned invalid JSON: ${message}. Output: ${stdout.slice(0, 500)}`);
  }
}

async function defaultRunRScript(script: string, inputJson: string, rscriptBin: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(rscriptBin, ["-e", script, inputJson], {
      maxBuffer: MAX_R_STDOUT_BYTES,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to run the IBGE R bridge. Install R, make sure Rscript is on PATH, and install the required R packages from the README. Details: ${message}`
    );
  }
}

function validatePnadcDownloadInput(input: DownloadPnadcWithRInput): void {
  if (!Number.isInteger(input.year) || input.year < 2012) {
    throw new Error("year must be an integer greater than or equal to 2012");
  }
  const selectors = [input.quarter, input.interview, input.topic].filter((value) => value !== undefined);
  if (selectors.length !== 1) {
    throw new Error("Provide exactly one PNAD Contínua selector: quarter, interview, or topic");
  }
  if (input.quarter !== undefined && (!Number.isInteger(input.quarter) || input.quarter < 1 || input.quarter > 4)) {
    throw new Error("quarter must be an integer from 1 to 4");
  }
  if (
    input.interview !== undefined &&
    (!Number.isInteger(input.interview) || input.interview < 1 || input.interview > 5)
  ) {
    throw new Error("interview must be an integer from 1 to 5");
  }
  if (input.topic !== undefined && (!Number.isInteger(input.topic) || input.topic < 1 || input.topic > 4)) {
    throw new Error("topic must be an integer from 1 to 4");
  }
  if (input.outputPath.trim() === "") {
    throw new Error("outputPath is required");
  }
}

function validateDatazoomInput(input: LoadDatazoomPnadcWithRInput): void {
  if (input.outputDir.trim() === "") {
    throw new Error("outputDir is required");
  }
  if (input.years.length === 0 || input.years.some((year) => !Number.isInteger(year) || year < 2012)) {
    throw new Error("years must contain at least one integer greater than or equal to 2012");
  }
  if (
    input.quarters !== undefined &&
    (input.quarters.length === 0 ||
      input.quarters.some((quarter) => !Number.isInteger(quarter) || quarter < 1 || quarter > 4))
  ) {
    throw new Error("quarters must contain integers from 1 to 4");
  }
}

function inferPnadcOutputFormat(outputPath: string): "parquet" | "rds" {
  const extension = path.extname(outputPath).toLowerCase();
  if (extension === ".rds") return "rds";
  return "parquet";
}

function asPackageStatuses(value: unknown): RPackageStatus[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      name: asString(record.name) ?? "",
      installed: asBoolean(record.installed) ?? false,
      version: asNullableString(record.version),
    };
  });
}

function asFileInfos(value: unknown): RFileInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      path: asString(record.path) ?? "",
      ...(record.relative_path === undefined ? {} : { relativePath: asString(record.relative_path) ?? "" }),
      bytes: asNumber(record.bytes) ?? 0,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asOptionalNumber(value: unknown): number | undefined {
  return asNumber(value) ?? undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => [key, String(item)])
  );
}

const R_BRIDGE_SCRIPT = `
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("R package jsonlite is required for the IBGE MCP R bridge. Install it with install.packages('jsonlite').")
}

args <- commandArgs(trailingOnly = TRUE)
input <- jsonlite::fromJSON(args[[1]], simplifyVector = FALSE)

empty_list <- list()

package_status <- function(packages) {
  lapply(packages, function(pkg) {
    installed <- requireNamespace(pkg, quietly = TRUE)
    list(
      name = pkg,
      installed = installed,
      version = if (installed) as.character(utils::packageVersion(pkg)) else NULL
    )
  })
}

ensure_package <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    stop(paste0("R package ", pkg, " is required. Install it before using this MCP tool."))
  }
}

null_if_empty <- function(value) {
  if (is.null(value) || length(value) == 0) {
    return(NULL)
  }
  value
}

package_versions <- function(packages) {
  versions <- list()
  for (pkg in packages) {
    if (requireNamespace(pkg, quietly = TRUE)) {
      versions[[pkg]] <- as.character(utils::packageVersion(pkg))
    }
  }
  versions
}

object_rows <- function(data) {
  if (inherits(data, "survey.design") && !is.null(data$variables)) {
    return(nrow(data$variables))
  }
  if (is.data.frame(data)) {
    return(nrow(data))
  }
  NULL
}

object_columns <- function(data) {
  if (inherits(data, "survey.design") && !is.null(data$variables)) {
    return(names(data$variables))
  }
  if (is.data.frame(data)) {
    return(names(data))
  }
  character()
}

write_output <- function(data, output_path, output_format, design) {
  dir.create(dirname(output_path), recursive = TRUE, showWarnings = FALSE)
  if (identical(output_format, "rds")) {
    saveRDS(data, output_path)
  } else if (identical(output_format, "parquet")) {
    if (isTRUE(design)) {
      stop("Parquet output requires design=FALSE because survey design objects are not rectangular.")
    }
    ensure_package("arrow")
    arrow::write_parquet(as.data.frame(data), output_path)
  } else {
    stop(paste("Unsupported output_format:", output_format))
  }
}

run_pnadc_get <- function() {
  ensure_package("PNADcIBGE")
  suppressPackageStartupMessages(library("PNADcIBGE"))
  args <- list(
    year = input$year,
    selected = isTRUE(input$selected),
    labels = isTRUE(input$labels),
    deflator = isTRUE(input$deflator),
    design = isTRUE(input$design),
    reload = isTRUE(input$reload),
    savedir = if (is.null(input$savedir)) tempdir() else input$savedir
  )
  dir.create(args$savedir, recursive = TRUE, showWarnings = FALSE)
  if (!is.null(input$quarter)) args$quarter <- input$quarter
  if (!is.null(input$interview)) args$interview <- input$interview
  if (!is.null(input$topic)) args$topic <- input$topic
  if (!is.null(null_if_empty(input$vars))) args$vars <- unlist(input$vars)
  if (!is.null(input$defyear)) args$defyear <- input$defyear
  if (!is.null(input$defperiod)) args$defperiod <- input$defperiod

  data <- do.call(PNADcIBGE::get_pnadc, args)
  write_output(data, input$output_path, input$output_format, isTRUE(input$design))

  list(
    backend = "PNADcIBGE",
    year = input$year,
    quarter = input$quarter,
    interview = input$interview,
    topic = input$topic,
    output_path = input$output_path,
    output_format = input$output_format,
    rows = object_rows(data),
    columns = object_columns(data),
    package_versions = package_versions(c("PNADcIBGE", "survey", "arrow"))
  )
}

file_entries <- function(output_dir) {
  files <- list.files(output_dir, recursive = TRUE, full.names = TRUE, all.files = FALSE, no.. = TRUE)
  lapply(files, function(file_path) {
    info <- file.info(file_path)
    list(
      path = normalizePath(file_path, winslash = "/", mustWork = FALSE),
      relative_path = sub(paste0("^", normalizePath(output_dir, winslash = "/", mustWork = FALSE), "/?"), "", normalizePath(file_path, winslash = "/", mustWork = FALSE)),
      bytes = unname(info$size)
    )
  })
}

run_datazoom_load_pnadc <- function() {
  ensure_package("datazoom.social")
  output_dir <- input$output_dir
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  save_options <- c(isTRUE(input$save_quarterly), identical(input$output_format, "csv"))
  args <- list(
    save_to = output_dir,
    years = unlist(input$years),
    quarters = unlist(input$quarters),
    panel = input$panel,
    raw_data = isTRUE(input$raw_data),
    save_options = save_options
  )
  if (!is.null(null_if_empty(input$vars))) args$vars <- unlist(input$vars)

  do.call(datazoom.social::load_pnadc, args)
  list(
    backend = "datazoom.social",
    output_dir = output_dir,
    years = unlist(input$years),
    quarters = unlist(input$quarters),
    panel = input$panel,
    raw_data = isTRUE(input$raw_data),
    output_format = input$output_format,
    save_quarterly = isTRUE(input$save_quarterly),
    files = file_entries(output_dir),
    package_versions = package_versions(c("datazoom.social", "PNADcIBGE", "arrow"))
  )
}

if (identical(input$action, "status")) {
  output <- list(
    r_version = R.version.string,
    packages = package_status(unlist(input$packages))
  )
} else if (identical(input$action, "pnadc_get")) {
  output <- run_pnadc_get()
} else if (identical(input$action, "datazoom_load_pnadc")) {
  output <- run_datazoom_load_pnadc()
} else {
  stop(paste("Unsupported R bridge action:", input$action))
}

cat(jsonlite::toJSON(output, dataframe = "rows", auto_unbox = TRUE, na = "null", null = "null"))
`;
