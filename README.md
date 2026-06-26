# IBGE Microdata MCP Server

Local-first MCP server for discovering, downloading, unpacking, converting, querying, and analyzing official public IBGE microdata.

This project does not host IBGE datasets. It uses IBGE download servers as the source of truth, downloads only files explicitly requested by the user, mirrors them into a local cache, and runs analysis on local files.

IBGE's raw public download host is `ftp.ibge.gov.br`. The server accepts both `https://` and `http://` URLs for that host. It tries to keep official HTTPS URLs where possible, but can fall back to official HTTP for public files when HTTPS is slow or unavailable. Tool output reports the resolved URL, transport used, and SHA-256 hash after download.

## Why Local-First

IBGE microdata files are public, but many are large enough that an MCP server should not return them directly in chat responses. The practical workflow is:

```text
discover official files -> inspect size -> download selected archive -> inspect/extract entries -> convert selected variables to Parquet -> query with DuckDB
```

In plain terms:

- **DuckDB** is a local analytical SQL engine. It can query large local files without running a database server.
- **Parquet** is a compressed columnar file format. Convert fixed-width TXT microdata once, then query only the columns you need.

## Core Generic Tools

| Tool | Purpose |
|---|---|
| `ibge_microdata_list_surveys` | List survey families with convenience support. |
| `ibge_microdata_connectivity_check` | Check whether this machine can reach IBGE download/API endpoints over HTTPS and HTTP. |
| `ibge_microdata_list_files` | List known public archive files for supported survey families. |
| `ibge_microdata_list_directory` | List any official `ftp.ibge.gov.br` directory. |
| `ibge_microdata_discover` | Bounded crawl of official IBGE directories to find microdata, data, documentation, and layout files. |
| `ibge_microdata_file_info` | Read file size, type, update timestamp, and validators with HTTP HEAD. |
| `ibge_microdata_download_file` | Download or reuse one official IBGE file in a local cache. |
| `ibge_microdata_list_cache` | List files already downloaded into a local cache with URLs, paths, sizes, and timestamps. |
| `ibge_microdata_cleanup_cache` | Preview or delete selected cached files using safe filters. |
| `ibge_microdata_zip_entries` | List files inside a local ZIP archive without extracting all of it. |
| `ibge_microdata_extract_zip_entry` | Extract one selected ZIP entry to a local path. |
| `ibge_microdata_inspect_layout` | Parse a local IBGE fixed-width input layout and search variables. |
| `ibge_microdata_fixed_width_file_to_parquet` | Convert a fixed-width TXT file plus official layout into a local Parquet file. |
| `ibge_microdata_fixed_width_zip_to_parquet` | Convert one fixed-width TXT entry inside a ZIP directly into local Parquet. |
| `ibge_microdata_query_parquet` | Run bounded read-only DuckDB SQL over local Parquet files exposed as `microdata`. |
| `ibge_microdata_query_parquet_views` | Run bounded read-only DuckDB SQL over multiple named Parquet views for joins. |
| `ibge_microdata_weighted_distribution` | Calculate weighted totals, means, group shares, and top-bracket shares over local Parquet views. |
| `ibge_microdata_describe_parquet_views` | Inspect schemas, row counts, and sample rows for named Parquet views. |
| `ibge_microdata_profile_parquet_views` | Profile local Parquet views with row counts, null counts, numeric ranges, frequent values, and samples. |
| `ibge_microdata_validate_recipe` | Validate a versioned JSON harmonization recipe without writing output. |
| `ibge_microdata_apply_recipe` | Apply a versioned JSON harmonization recipe and write a derived Parquet file. |

The generic path is discovery, caching, layout inspection, Parquet conversion, profiling, and DuckDB querying. These tools are the main public surface of the server.

## Optional Survey-Specific Helpers

These helpers are layered on top of the same local-first workflow. They are useful shortcuts for known IBGE formats, but they are not required for the generic workflow.

| Tool | Purpose |
|---|---|
| `ibge_microdata_pof_manifest` | Parse a POF Excel dictionary and map record sheets to data ZIP entries. |
| `ibge_microdata_pof_zip_record_to_parquet` | Convert one POF record from a Dados ZIP to Parquet using the POF dictionary. |
| `ibge_microdata_pnadc_analyze_file` | PNAD Contínua convenience summary over an extracted fixed-width TXT file. |
| `ibge_microdata_pnadc_analyze_zip` | PNAD Contínua convenience summary directly over a TXT entry inside a ZIP. |
| `ibge_microdata_r_status` | Check local `Rscript` and required R packages. |
| `ibge_microdata_pnadc_r_download` | Use `PNADcIBGE` through R to download PNAD Contínua and write Parquet or RDS. |
| `ibge_microdata_datazoom_pnadc_load` | Use `datazoom.social` through R to load PNAD Contínua and save produced files. |

## Prerequisites

This MCP is a local tool. Users are expected to have:

- Node.js 18.20 or newer.
- pnpm.
- R with `Rscript` available on `PATH`.

R is included as a project prerequisite because PNAD Contínua and Data Zoom workflows are best supported by the existing Brazilian R ecosystem. The MCP server itself still runs as a Node/TypeScript process and returns MCP-friendly JSON, Markdown, and local file paths.

## Install

1. Install system runtimes.

On macOS with Homebrew:

```bash
brew install node r
npm install -g pnpm@11.7.0
```

On Windows with winget:

```powershell
winget install OpenJS.NodeJS
winget install RProject.R
npm install -g pnpm@11.7.0
```

On Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y nodejs npm r-base
sudo npm install -g pnpm@11.7.0
```

Linux package managers sometimes ship older Node.js versions. If `node --version` is below 18.20, install a newer Node.js release from NodeSource, nvm, or the official Node.js installer.

You can also install the same tools from their official installers:

- Node.js: https://nodejs.org/
- pnpm: https://pnpm.io/installation
- R: https://cran.r-project.org/

Check that all three are available:

```bash
node --version
pnpm --version
Rscript --version
```

2. Clone the GitHub repository:

```bash
git clone https://github.com/emmanueltsallis/ibge-microdata-mcp.git
cd ibge-microdata-mcp
```

3. Install Node dependencies and build the local MCP server:

```bash
pnpm install
pnpm run build
```

4. Install the baseline R packages used by the R-backed IBGE workflows:

```bash
Rscript -e 'install.packages(c("PNADcIBGE", "survey", "jsonlite", "arrow"), repos = "https://cloud.r-project.org")'
Rscript -e 'install.packages("datazoom.social", repos = c("https://datazoompuc.r-universe.dev", "https://cloud.r-project.org"))'
```

## Run

```bash
node dist/index.js
```

Example MCP client config:

```json
{
  "mcpServers": {
    "ibge-microdata": {
      "command": "node",
      "args": ["/absolute/path/to/ibge-microdata-mcp/dist/index.js"]
    }
  }
}
```

For a shorter generic walkthrough, see [examples/generic-workflow.md](examples/generic-workflow.md). For a starter harmonization recipe, see [examples/harmonization-recipe.json](examples/harmonization-recipe.json). For external harmonization sources that can inform recipes, see [docs/harmonization-sources.md](docs/harmonization-sources.md).

## R-Backed PNADc Workflow

Use the R status tool first:

```text
ibge_microdata_r_status({})
```

Download PNAD Contínua through `PNADcIBGE` and write a Parquet file that the MCP can query with DuckDB:

```text
ibge_microdata_pnadc_r_download({
  "year": 2024,
  "quarter": 4,
  "vars": ["UF", "V1028"],
  "outputPath": "/Users/you/.cache/ibge-microdata-mcp/converted/pnadc_2024q4.parquet"
})
```

Use `datazoom.social` when you want Data Zoom's PNAD Contínua processing or panel identifiers:

```text
ibge_microdata_datazoom_pnadc_load({
  "outputDir": "/Users/you/.cache/ibge-microdata-mcp/datazoom/pnadc",
  "years": [2024],
  "quarters": [1, 2, 3, 4],
  "panel": "basic",
  "outputFormat": "parquet"
})
```

## Generic Workflow

1. Find public files from a known survey family or an official directory:

```text
ibge_microdata_list_surveys({})
```

```text
ibge_microdata_connectivity_check({})
```

```text
ibge_microdata_list_files({
  "survey": "pof"
})
```

```text
ibge_microdata_discover({
  "rootUrl": "https://ftp.ibge.gov.br/",
  "maxDepth": 3,
  "maxDirectories": 50
})
```

2. Inspect file metadata before downloading:

```text
ibge_microdata_file_info({
  "url": "https://ftp.ibge.gov.br/path/to/public/archive.zip"
})
```

3. Download to a local cache:

```text
ibge_microdata_download_file({
  "url": "https://ftp.ibge.gov.br/path/to/public/archive.zip",
  "cacheRoot": "/Users/you/.cache/ibge-microdata-mcp"
})
```

The downloader mirrors the official `ftp.ibge.gov.br` path under `cacheRoot`. On repeated calls, it checks IBGE `content-length` metadata first and returns a cache hit when the existing local file has the expected byte size.

If HTTPS to `ftp.ibge.gov.br` times out, the downloader may retry the same public file over `http://ftp.ibge.gov.br`. This does not send credentials or private data; it only downloads public IBGE files. The response reports `transport`, `usedFallback`, and `sha256` so the transfer remains auditable in headless MCP use.

4. List the cache later if you need to rediscover local paths:

```text
ibge_microdata_list_cache({
  "cacheRoot": "/Users/you/.cache/ibge-microdata-mcp",
  "limit": 50,
  "offset": 0
})
```

5. Preview cache cleanup when storage grows:

```text
ibge_microdata_cleanup_cache({
  "cacheRoot": "/Users/you/.cache/ibge-microdata-mcp",
  "dryRun": true,
  "olderThanDays": 30,
  "minBytes": 100000000
})
```

The cleanup tool defaults to `dryRun: true`, requires at least one filter, and only considers files under `cacheRoot/ftp.ibge.gov.br`. Set `dryRun: false` only after reviewing the preview.

6. Inspect archive contents:

```text
ibge_microdata_zip_entries({
  "zipPath": "/Users/you/.cache/ibge-microdata-mcp/ftp.ibge.gov.br/path/to/public/archive.zip"
})
```

7. Inspect a fixed-width layout and choose variables:

```text
ibge_microdata_inspect_layout({
  "layoutPath": "/path/to/official-input-layout.txt",
  "search": "weight",
  "limit": 50
})
```

8. Convert selected variables to Parquet:

```text
ibge_microdata_fixed_width_zip_to_parquet({
  "layoutPath": "/path/to/official-input-layout.txt",
  "zipPath": "/Users/you/.cache/ibge-microdata-mcp/ftp.ibge.gov.br/path/to/public/archive.zip",
  "entryName": "MICRODATA.txt",
  "outputPath": "/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet",
  "selectedVariables": ["record_id", "region", "sample_weight", "target_value"]
})
```

9. Profile the Parquet file before writing custom SQL:

```text
ibge_microdata_profile_parquet_views({
  "views": [
    {
      "name": "microdata",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet"]
    }
  ],
  "columns": ["region", "sample_weight", "target_value"],
  "topK": 10,
  "sampleRows": 3
})
```

If `columns` is omitted, the tool profiles the first 25 columns by default. This keeps wide microdata files manageable while still giving enough information to choose variables and write queries.

10. Query the Parquet file with DuckDB:

```text
ibge_microdata_query_parquet({
  "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet"],
  "sql": "select region, sum(sample_weight * target_value) / sum(sample_weight) as weighted_mean from microdata group by region order by region",
  "maxRows": 100
})
```

The query tools accept only `SELECT` or `WITH` queries, reject semicolons and write-oriented keywords, and cap returned rows.

## Harmonization Recipes

Recipes are optional JSON files that make harmonization assumptions explicit and reusable. The MCP does not ship one universal harmonization standard; instead, a recipe declares the required input views/columns, an output `SELECT` transformation, optional source references, and validation checks.

```text
ibge_microdata_validate_recipe({
  "recipePath": "/path/to/harmonization-recipe.json",
  "views": [
    {
      "name": "microdata",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet"]
    }
  ],
  "sampleRows": 5
})
```

If the validation output says requirements and validations passed, write the harmonized Parquet file:

```text
ibge_microdata_apply_recipe({
  "recipePath": "/path/to/harmonization-recipe.json",
  "views": [
    {
      "name": "microdata",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet"]
    }
  ],
  "outputPath": "/Users/you/.cache/ibge-microdata-mcp/converted/harmonized.parquet",
  "sampleRows": 5
})
```

Recipe SQL accepts only `SELECT` or `WITH` statements. The validation tool reports missing input columns, output schema, sample output rows, and validation results without writing a file. The apply tool writes the harmonized output only when requirements and validations pass.

## Weighted Distributions

Use `ibge_microdata_weighted_distribution` when a Parquet file contains one row per analytical unit, a numeric value column, and a numeric survey/sample weight column:

```text
ibge_microdata_weighted_distribution({
  "views": [
    {
      "name": "microdata",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet"]
    }
  ],
  "unitSql": "select region, target_value as value, sample_weight as weight from microdata",
  "valueColumn": "value",
  "weightColumn": "weight",
  "groupColumn": "region",
  "topPercents": [0.01, 0.05, 0.1]
})
```

The tool ranks units by the value column, applies weights, reports total weight, total value, weighted mean, optional group shares, and top-bracket shares. If a top bracket cuts through tied values at the cutoff, the tied bucket is allocated proportionally.

## Relational Records

Some surveys publish multiple record files. Convert each record to Parquet, inspect the resulting schemas, then join named views:

```text
ibge_microdata_describe_parquet_views({
  "views": [
    {
      "name": "record_a",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/record_a.parquet"]
    },
    {
      "name": "record_b",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/record_b.parquet"]
    }
  ],
  "includeRowCounts": true,
  "sampleRows": 3
})
```

```text
ibge_microdata_query_parquet_views({
  "views": [
    {
      "name": "record_a",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/record_a.parquet"]
    },
    {
      "name": "record_b",
      "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/record_b.parquet"]
    }
  ],
  "sql": "select a.region, count(*) as rows from record_a a join record_b b using (record_id) group by a.region order by a.region",
  "maxRows": 100
})
```

## POF Dictionaries

POF editions use Excel dictionary workbooks. Use the manifest tool to map dictionary sheets to TXT entries before converting records:

```text
ibge_microdata_pof_manifest({
  "dictionaryPath": "/path/to/dictionary.xls",
  "dataZipPath": "/Users/you/.cache/ibge-microdata-mcp/ftp.ibge.gov.br/path/to/Dados.zip",
  "search": "weight",
  "variableLimit": 20
})
```

```text
ibge_microdata_pof_zip_record_to_parquet({
  "dictionaryPath": "/path/to/dictionary.xls",
  "zipPath": "/Users/you/.cache/ibge-microdata-mcp/ftp.ibge.gov.br/path/to/Dados.zip",
  "recordName": "Domicílio",
  "outputPath": "/Users/you/.cache/ibge-microdata-mcp/converted/pof_record.parquet",
  "selectedVariables": ["UF", "ESTRATO_POF", "TIPO_SITUACAO_REG"]
})
```

The POF converter applies implied decimal scaling from the dictionary and writes DuckDB-queryable Parquet files.

## Tests

Offline unit tests:

```bash
pnpm test
```

Live smoke tests against official IBGE endpoints:

```bash
RUN_IBGE_SMOKE=1 pnpm test -- tests/smoke.test.ts
```

Smoke tests list official directories, read HEAD metadata, and download the smaller POF documentation ZIP to verify dictionary parsing. They do not download large microdata data ZIPs.

Local R setup smoke test:

```bash
RUN_R_SMOKE=1 pnpm test -- tests/r-smoke.test.ts
```

The R smoke test checks `Rscript` and baseline R package availability. It does not download PNAD microdata.

## Current Limits

- This is a local-first MCP server, not a hosted warehouse of all IBGE microdata.
- Discovery is deliberately bounded; broad root crawls should use explicit `maxDepth` and `maxDirectories` values to avoid excessive requests.
- Generic fixed-width conversion, Parquet profiling/querying, weighted distribution summaries, and POF dictionary conversion are implemented.
- Additional survey-specific harmonized recipes can be added as optional layers without changing the generic workflow.

## License

MIT. See [LICENSE](LICENSE).
