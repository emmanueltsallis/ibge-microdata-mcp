import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeParquetViews,
  profileParquetViews,
  queryParquetFiles,
  queryParquetViews,
  weightedDistributionFromParquetViews
} from "../src/parquet-query.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-query-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("queryParquetFiles", () => {
  it("runs bounded read-only SQL against a microdata view over local Parquet files", async () => {
    const parquetPath = path.join(tempDir, "sample.parquet");
    await createSampleParquet(parquetPath);

    const result = await queryParquetFiles({
      parquetPaths: [parquetPath],
      sql: "select UF, sum(V1028) as weight from microdata group by UF order by UF",
      maxRows: 10
    });

    expect(result.rows).toEqual([
      { UF: "33", weight: 80 },
      { UF: "35", weight: 10 }
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("limits returned rows while reporting truncation", async () => {
    const parquetPath = path.join(tempDir, "sample.parquet");
    await createSampleParquet(parquetPath);

    const result = await queryParquetFiles({
      parquetPaths: [parquetPath],
      sql: "select * from microdata order by UF",
      maxRows: 1
    });

    expect(result.rows).toEqual([{ UF: "33", V1028: 80 }]);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("rejects non-read-only SQL", async () => {
    await expect(
      queryParquetFiles({
        parquetPaths: [path.join(tempDir, "sample.parquet")],
        sql: "copy microdata to 'out.parquet' (format parquet)"
      })
    ).rejects.toThrow("Only SELECT or WITH queries are supported");
  });
});

describe("queryParquetViews", () => {
  it("runs bounded read-only SQL joins across named local Parquet views", async () => {
    const domicilioPath = path.join(tempDir, "domicilio.parquet");
    const moradorPath = path.join(tempDir, "morador.parquet");
    await createParquetFromSql(
      domicilioPath,
      "create table sample(COD_DOM varchar, UF varchar, V1028 double)",
      "insert into sample values ('001', '33', 80), ('002', '35', 10)"
    );
    await createParquetFromSql(
      moradorPath,
      "create table sample(COD_DOM varchar, PESSOA varchar, RENDA double)",
      "insert into sample values ('001', '01', 1000), ('001', '02', 500), ('002', '01', 3000)"
    );

    const result = await queryParquetViews({
      views: [
        { name: "domicilio", parquetPaths: [domicilioPath] },
        { name: "morador", parquetPaths: [moradorPath] }
      ],
      sql: `
        select d.UF, sum(m.RENDA) as household_income
        from domicilio d
        join morador m using (COD_DOM)
        group by d.UF
        order by d.UF
      `,
      maxRows: 10
    });

    expect(result.rows).toEqual([
      { UF: "33", household_income: 1500 },
      { UF: "35", household_income: 3000 }
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.views.map((view) => view.name)).toEqual(["domicilio", "morador"]);
  });

  it("rejects unsafe view names", async () => {
    await expect(
      queryParquetViews({
        views: [{ name: "bad;drop", parquetPaths: [path.join(tempDir, "sample.parquet")] }],
        sql: "select * from bad"
      })
    ).rejects.toThrow("View names must be SQL identifiers");
  });
});

describe("describeParquetViews", () => {
  it("returns schema, row count, and optional sample rows for named Parquet views", async () => {
    const domicilioPath = path.join(tempDir, "domicilio.parquet");
    await createParquetFromSql(
      domicilioPath,
      "create table sample(COD_DOM varchar, UF varchar, V1028 double)",
      "insert into sample values ('001', '33', 80), ('002', '35', 10)"
    );

    const result = await describeParquetViews({
      views: [{ name: "domicilio", parquetPaths: [domicilioPath] }],
      includeRowCounts: true,
      sampleRows: 1
    });

    expect(result.views[0].columns).toEqual([
      { name: "COD_DOM", type: "VARCHAR" },
      { name: "UF", type: "VARCHAR" },
      { name: "V1028", type: "DOUBLE" }
    ]);
    expect(result.views[0].rowCount).toBe(2);
    expect(result.views[0].sampleRows).toEqual([{ COD_DOM: "001", UF: "33", V1028: 80 }]);
  });

  it("rejects unsafe view names before creating DuckDB views", async () => {
    await expect(
      describeParquetViews({
        views: [{ name: "domicilio;drop", parquetPaths: [path.join(tempDir, "domicilio.parquet")] }]
      })
    ).rejects.toThrow("View names must be SQL identifiers");
  });
});

describe("profileParquetViews", () => {
  it("returns bounded column profiles for local Parquet views", async () => {
    const parquetPath = path.join(tempDir, "profile.parquet");
    await createParquetFromSql(
      parquetPath,
      "create table sample(region varchar, target_value double, sample_weight double)",
      "insert into sample values ('33', 100, 2), ('33', 200, 3), ('35', null, 5)"
    );

    const result = await profileParquetViews({
      views: [{ name: "microdata", parquetPaths: [parquetPath] }],
      topK: 2,
      sampleRows: 1
    });

    expect(result.views[0].rowCount).toBe(3);
    expect(result.views[0].totalColumns).toBe(3);
    expect(result.views[0].profiledColumns).toBe(3);
    expect(result.views[0].columnsTruncated).toBe(false);
    expect(result.views[0].sampleRows).toEqual([{ region: "33", target_value: 100, sample_weight: 2 }]);

    const region = result.views[0].columns.find((column) => column.name === "region");
    expect(region).toEqual({
      name: "region",
      type: "VARCHAR",
      nullCount: 0,
      nonNullCount: 3,
      topValues: [
        { value: "33", count: 2 },
        { value: "35", count: 1 }
      ]
    });

    const targetValue = result.views[0].columns.find((column) => column.name === "target_value");
    expect(targetValue).toEqual({
      name: "target_value",
      type: "DOUBLE",
      nullCount: 1,
      nonNullCount: 2,
      numeric: {
        min: 100,
        max: 200,
        mean: 150
      },
      topValues: [
        { value: 100, count: 1 },
        { value: 200, count: 1 }
      ]
    });
  });

  it("limits profiled columns unless specific columns are requested", async () => {
    const parquetPath = path.join(tempDir, "wide.parquet");
    await createParquetFromSql(
      parquetPath,
      "create table sample(region varchar, value_one double, value_two double)",
      "insert into sample values ('33', 100, 200)"
    );

    const truncated = await profileParquetViews({
      views: [{ name: "microdata", parquetPaths: [parquetPath] }],
      maxColumns: 2
    });

    expect(truncated.views[0].columns.map((column) => column.name)).toEqual(["region", "value_one"]);
    expect(truncated.views[0].columnsTruncated).toBe(true);

    const selected = await profileParquetViews({
      views: [{ name: "microdata", parquetPaths: [parquetPath] }],
      columns: ["value_two"]
    });

    expect(selected.views[0].columns.map((column) => column.name)).toEqual(["value_two"]);

    await expect(
      profileParquetViews({
        views: [{ name: "microdata", parquetPaths: [parquetPath] }],
        columns: ["missing_column"]
      })
    ).rejects.toThrow("Column not found in view microdata: missing_column");
  });
});

describe("weightedDistributionFromParquetViews", () => {
  it("computes weighted totals, group shares, and top-bracket shares from local Parquet views", async () => {
    const parquetPath = path.join(tempDir, "income.parquet");
    await createParquetFromSql(
      parquetPath,
      "create table sample(work_group varchar, income double, weight double)",
      "insert into sample values ('employee', 100, 50), ('employee', 200, 20), ('employer', 1000, 10), ('employer', 0, 20)"
    );

    const result = await weightedDistributionFromParquetViews({
      views: [{ name: "microdata", parquetPaths: [parquetPath] }],
      unitSql: "select work_group, income, weight from microdata",
      valueColumn: "income",
      weightColumn: "weight",
      groupColumn: "work_group",
      topPercents: [0.1, 0.3]
    });

    expect(result.rowsUsed).toBe(4);
    expect(result.distinctValues).toBe(4);
    expect(result.totalWeight).toBe(100);
    expect(result.totalValue).toBe(19000);
    expect(result.weightedMean).toBe(190);
    expect(result.groups).toEqual([
      {
        groupValue: "employer",
        weight: 30,
        totalValue: 10000,
        populationShare: 0.3,
        valueShare: 10000 / 19000,
        weightedMean: 10000 / 30
      },
      {
        groupValue: "employee",
        weight: 70,
        totalValue: 9000,
        populationShare: 0.7,
        valueShare: 9000 / 19000,
        weightedMean: 9000 / 70
      }
    ]);
    expect(result.topBrackets[0]).toEqual({
      percent: 0.1,
      cutoffValue: 1000,
      thresholdWeight: 10,
      weight: 10,
      totalValue: 10000,
      valueShare: 10000 / 19000,
      weightedMean: 1000,
      groups: [
        {
          groupValue: "employer",
          weight: 10,
          totalValue: 10000,
          populationShareWithinBracket: 1,
          valueShareWithinBracket: 1,
          valueShareOfTotal: 10000 / 19000
        }
      ]
    });
    expect(result.topBrackets[1].percent).toBe(0.3);
    expect(result.topBrackets[1].cutoffValue).toBe(200);
    expect(result.topBrackets[1].weight).toBe(30);
    expect(result.topBrackets[1].totalValue).toBe(14000);
    expect(result.topBrackets[1].groups.map((group) => group.groupValue)).toEqual(["employee", "employer"]);
  });

  it("allocates tied cutoff values proportionally across groups inside top brackets", async () => {
    const parquetPath = path.join(tempDir, "ties.parquet");
    await createParquetFromSql(
      parquetPath,
      "create table sample(work_group varchar, income double, weight double)",
      "insert into sample values ('employee', 1000, 10), ('employer', 1000, 30), ('other', 100, 60)"
    );

    const result = await weightedDistributionFromParquetViews({
      views: [{ name: "microdata", parquetPaths: [parquetPath] }],
      unitSql: "select work_group, income, weight from microdata",
      valueColumn: "income",
      weightColumn: "weight",
      groupColumn: "work_group",
      topPercents: [0.2]
    });

    expect(result.topBrackets[0].cutoffValue).toBe(1000);
    expect(result.topBrackets[0].weight).toBe(20);
    expect(result.topBrackets[0].totalValue).toBe(20000);
    expect(result.topBrackets[0].groups).toEqual([
      {
        groupValue: "employee",
        weight: 5,
        totalValue: 5000,
        populationShareWithinBracket: 0.25,
        valueShareWithinBracket: 0.25,
        valueShareOfTotal: 5000 / 46000
      },
      {
        groupValue: "employer",
        weight: 15,
        totalValue: 15000,
        populationShareWithinBracket: 0.75,
        valueShareWithinBracket: 0.75,
        valueShareOfTotal: 15000 / 46000
      }
    ]);
  });
});

async function createSampleParquet(parquetPath: string): Promise<void> {
  await createParquetFromSql(
    parquetPath,
    "create table sample(UF varchar, V1028 double)",
    "insert into sample values ('33', 80), ('35', 10)"
  );
}

async function createParquetFromSql(parquetPath: string, createSql: string, insertSql: string): Promise<void> {
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
