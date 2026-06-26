import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyHarmonizationRecipe } from "../src/recipe.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-recipe-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("applyHarmonizationRecipe", () => {
  it("applies a portable JSON recipe to local Parquet views and writes a harmonized Parquet output", async () => {
    const parquetPath = path.join(tempDir, "raw.parquet");
    const recipePath = path.join(tempDir, "recipe.json");
    const outputPath = path.join(tempDir, "harmonized", "output.parquet");
    await createParquetFromSql(
      parquetPath,
      "create table sample(UF varchar, V1028 double, raw_value double)",
      "insert into sample values ('33', 80, 1000), ('35', 10, 3000)"
    );
    await writeRecipe(recipePath, {
      schemaVersion: 1,
      name: "basic_region_value",
      description: "Minimal portable recipe for tests",
      sources: [{ label: "Test dictionary", url: "https://example.test/dictionary" }],
      requiredViews: [{ name: "microdata", columns: ["UF", "V1028", "raw_value"] }],
      output: {
        viewName: "harmonized_microdata",
        sql: `
          select
            UF as region,
            cast(V1028 as double) as sample_weight,
            cast(raw_value as double) as target_value
          from microdata
        `
      },
      validations: [
        {
          name: "row_count",
          sql: "select count(*) as rows_checked from harmonized_microdata",
          expect: { column: "rows_checked", equals: 2 }
        }
      ]
    });

    const result = await applyHarmonizationRecipe({
      recipePath,
      views: [{ name: "microdata", parquetPaths: [parquetPath] }],
      outputPath,
      sampleRows: 1
    });

    expect(result).toMatchObject({
      recipe: {
        schemaVersion: 1,
        name: "basic_region_value",
        description: "Minimal portable recipe for tests"
      },
      outputPath,
      outputRows: 2,
      validationsPassed: true
    });
    expect(result.outputColumns).toEqual([
      { name: "region", type: "VARCHAR" },
      { name: "sample_weight", type: "DOUBLE" },
      { name: "target_value", type: "DOUBLE" }
    ]);
    expect(result.validations).toEqual([
      {
        name: "row_count",
        passed: true,
        rows: [{ rows_checked: "2" }]
      }
    ]);
    expect(result.sampleRows).toEqual([{ region: "33", sample_weight: 80, target_value: 1000 }]);
    await expect(readParquetRows(outputPath)).resolves.toEqual([
      { region: "33", sample_weight: 80, target_value: 1000 },
      { region: "35", sample_weight: 10, target_value: 3000 }
    ]);
  });

  it("rejects recipes when required input columns are missing", async () => {
    const parquetPath = path.join(tempDir, "raw.parquet");
    const recipePath = path.join(tempDir, "recipe.json");
    await createParquetFromSql(
      parquetPath,
      "create table sample(UF varchar, V1028 double)",
      "insert into sample values ('33', 80)"
    );
    await writeRecipe(recipePath, {
      schemaVersion: 1,
      name: "missing_column_recipe",
      requiredViews: [{ name: "microdata", columns: ["UF", "missing_value"] }],
      output: {
        viewName: "harmonized_microdata",
        sql: "select UF as region from microdata"
      }
    });

    await expect(
      applyHarmonizationRecipe({
        recipePath,
        views: [{ name: "microdata", parquetPaths: [parquetPath] }],
        outputPath: path.join(tempDir, "out.parquet")
      })
    ).rejects.toThrow("Recipe requires missing column in view microdata: missing_value");
  });

  it("rejects non-read-only recipe SQL", async () => {
    const parquetPath = path.join(tempDir, "raw.parquet");
    const recipePath = path.join(tempDir, "recipe.json");
    await createParquetFromSql(
      parquetPath,
      "create table sample(UF varchar)",
      "insert into sample values ('33')"
    );
    await writeRecipe(recipePath, {
      schemaVersion: 1,
      name: "unsafe_recipe",
      requiredViews: [{ name: "microdata", columns: ["UF"] }],
      output: {
        viewName: "harmonized_microdata",
        sql: "drop table microdata"
      }
    });

    await expect(
      applyHarmonizationRecipe({
        recipePath,
        views: [{ name: "microdata", parquetPaths: [parquetPath] }],
        outputPath: path.join(tempDir, "out.parquet")
      })
    ).rejects.toThrow("Only SELECT or WITH queries are supported");
  });

  it("reports failed validation checks without writing output", async () => {
    const parquetPath = path.join(tempDir, "raw.parquet");
    const recipePath = path.join(tempDir, "recipe.json");
    const outputPath = path.join(tempDir, "out.parquet");
    await createParquetFromSql(
      parquetPath,
      "create table sample(UF varchar)",
      "insert into sample values ('33')"
    );
    await writeRecipe(recipePath, {
      schemaVersion: 1,
      name: "failing_validation_recipe",
      requiredViews: [{ name: "microdata", columns: ["UF"] }],
      output: {
        viewName: "harmonized_microdata",
        sql: "select UF as region from microdata"
      },
      validations: [
        {
          name: "expected_two_rows",
          sql: "select count(*) as row_count from harmonized_microdata",
          expect: { column: "row_count", equals: 2 }
        }
      ]
    });

    await expect(
      applyHarmonizationRecipe({
        recipePath,
        views: [{ name: "microdata", parquetPaths: [parquetPath] }],
        outputPath
      })
    ).rejects.toThrow("Recipe validation failed: expected_two_rows");
    await expect(readParquetRows(outputPath)).rejects.toThrow();
  });
});

async function writeRecipe(recipePath: string, recipe: unknown): Promise<void> {
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
}

async function createParquetFromSql(parquetPath: string, createSql: string, insertSql: string): Promise<void> {
  await mkdir(path.dirname(parquetPath), { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(createSql);
    await connection.run(insertSql);
    await connection.run(`copy sample to '${parquetPath.replaceAll("'", "''")}' (format parquet)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function readParquetRows(parquetPath: string): Promise<Array<Record<string, unknown>>> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `select * from read_parquet('${parquetPath.replaceAll("'", "''")}') order by region`
    );
    return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
