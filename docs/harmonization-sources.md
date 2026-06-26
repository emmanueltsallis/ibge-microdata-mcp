# Harmonization Sources

This MCP keeps harmonization rules outside the server core. The server provides the generic machinery to inspect, convert, profile, validate, and apply recipes. A recipe can cite official IBGE dictionaries, Data Zoom materials, Base dos Dados tables, or a user's own research decisions.

## What Is Included Directly

- Official IBGE fixed-width layouts can be parsed with `ibge_microdata_inspect_layout`.
- POF Excel dictionaries can be parsed with `ibge_microdata_pof_manifest` and used for POF ZIP-to-Parquet conversion.
- JSON recipes can be validated with `ibge_microdata_validate_recipe` and applied with `ibge_microdata_apply_recipe`.

These are data-access and metadata tools. They do not declare one universal harmonized standard.

## External Sources To Use In Recipes

### IBGE official dictionaries and layouts

IBGE layouts and dictionaries are the first source of truth for raw variable names, positions, widths, decimal scaling, and official descriptions. They are mostly metadata. They usually explain what a raw variable means in a specific survey edition, but they do not by themselves decide cross-year concepts such as a single harmonized income, consumption, family, work-status, or geography variable.

### Data Zoom / PUC-Rio

Data Zoom projects provide support files and harmonization materials for Brazilian household surveys, including tools for reading IBGE surveys, standardizing variables over time, deflating variables, and constructing PNAD Continua panel identifiers.

Useful repositories:

- https://github.com/datazoompuc/datazoom_social_Stata
- https://github.com/datazoompuc/datazoom.social

These are good sources for recipe authors. They are not bundled as built-in MCP rules because licensing and citation requirements can vary by material, and because adopting their choices as defaults would make this MCP an opinionated harmonized survey package.

### Base dos Dados

Base dos Dados provides a public data platform, SDKs, and its own MCP server with dataset metadata and BigQuery-oriented access.

Useful repositories:

- https://github.com/basedosdados/mcp
- https://github.com/basedosdados/sdk

Base dos Dados is complementary to this project. Their MCP is closer to a metadata and warehouse-query interface. This MCP is local-first and oriented around official IBGE files on the user's machine.

## How To Use An External Dictionary

1. Use this MCP to download/convert official IBGE files to local Parquet.
2. Create a JSON recipe that maps raw columns into the harmonized variables you want.
3. Put source references in the recipe's `sources` field.
4. Run `ibge_microdata_validate_recipe` to check required columns, output schema, sample rows, and validation queries.
5. Run `ibge_microdata_apply_recipe` only after validation passes.

This design lets users plug in Data Zoom-inspired, IBGE-only, Base dos Dados-inspired, or custom recipes without changing the MCP server code.
