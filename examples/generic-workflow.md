# Generic IBGE Microdata Workflow

This example keeps the MCP workflow survey-neutral. It uses official IBGE URLs, a local cache, fixed-width layout inspection, Parquet conversion, profiling, and read-only DuckDB queries.

## 1. Discover Files

```text
ibge_microdata_discover({
  "rootUrl": "https://ftp.ibge.gov.br/",
  "maxDepth": 3,
  "maxDirectories": 50
})
```

Use `ibge_microdata_list_files` when a supported survey family is enough:

```text
ibge_microdata_list_files({
  "survey": "pof"
})
```

## 2. Inspect Before Downloading

```text
ibge_microdata_file_info({
  "url": "https://ftp.ibge.gov.br/path/to/public/archive.zip"
})
```

## 3. Download Into A Local Cache

```text
ibge_microdata_download_file({
  "url": "https://ftp.ibge.gov.br/path/to/public/archive.zip",
  "cacheRoot": "/Users/you/.cache/ibge-microdata-mcp"
})
```

## 4. Preview Cache Cleanup

```text
ibge_microdata_cleanup_cache({
  "cacheRoot": "/Users/you/.cache/ibge-microdata-mcp",
  "dryRun": true,
  "olderThanDays": 30,
  "minBytes": 100000000
})
```

Use `dryRun: true` first. The tool requires at least one filter and only considers files under the mirrored `ftp.ibge.gov.br` cache tree.

## 5. Inspect Archive Entries

```text
ibge_microdata_zip_entries({
  "zipPath": "/Users/you/.cache/ibge-microdata-mcp/ftp.ibge.gov.br/path/to/public/archive.zip"
})
```

## 6. Inspect The Fixed-Width Layout

```text
ibge_microdata_inspect_layout({
  "layoutPath": "/path/to/official-input-layout.txt",
  "search": "weight",
  "limit": 50
})
```

## 7. Convert Selected Columns To Parquet

```text
ibge_microdata_fixed_width_zip_to_parquet({
  "layoutPath": "/path/to/official-input-layout.txt",
  "zipPath": "/Users/you/.cache/ibge-microdata-mcp/ftp.ibge.gov.br/path/to/public/archive.zip",
  "entryName": "MICRODATA.txt",
  "outputPath": "/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet",
  "selectedVariables": ["record_id", "region", "sample_weight", "target_value"]
})
```

## 8. Profile The Parquet Output

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

## 9. Query With DuckDB

```text
ibge_microdata_query_parquet({
  "parquetPaths": ["/Users/you/.cache/ibge-microdata-mcp/converted/sample.parquet"],
  "sql": "select region, sum(sample_weight * target_value) / sum(sample_weight) as weighted_mean from microdata group by region order by region",
  "maxRows": 100
})
```

## 10. Optional Weighted Distribution

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

## 11. Optional Harmonization Recipe

Use a recipe when assumptions should be explicit, versioned, and reusable. See [harmonization-recipe.json](harmonization-recipe.json) for the JSON structure.

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

Then write the harmonized Parquet file only after the validation output passes:

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
