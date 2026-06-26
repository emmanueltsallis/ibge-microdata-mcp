import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summarizePnadcTextFile } from "../src/pnadc-file.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-pnadc-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("summarizePnadcTextFile", () => {
  it("streams a fixed-width PNAD text file and summarizes selected variables", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "PNADC_sample.txt");
    await writeFile(
      layoutPath,
      `
@0001 Ano   $4.   /* Ano de referência */
@0050 V1028   15.   /* Peso */
@0186 V4019   $1.   /* CNPJ */
@0417 VD4009   $2.   /* Posição */
@0444 VD4019   8.   /* Rendimento */
`
    );

    await writeFile(
      dataPath,
      [
        sampleLine({ weight: "000000000000080", cnpj: " ", group: " 1", income: "00001000" }),
        sampleLine({ weight: "000000000000010", cnpj: "1", group: " 8", income: "00010000" })
      ].join("\n")
    );

    const result = await summarizePnadcTextFile({
      layoutPath,
      dataPath,
      topPercents: [0.1]
    });

    expect(result.rowsRead).toBe(2);
    expect(result.summary.totalWeight).toBe(90);
    expect(result.summary.groups.employee.weight).toBe(80);
    expect(result.summary.groups.employer_with_cnpj.meanIncome).toBe(10000);
    expect(result.summary.topBrackets.top10.groupWeightShares.employer_with_cnpj).toBe(1);
  });
});

function sampleLine({
  weight,
  cnpj,
  group,
  income
}: {
  weight: string;
  cnpj: string;
  group: string;
  income: string;
}): string {
  const chars = Array.from({ length: 451 }, () => " ");
  chars.splice(0, 4, ..."2024");
  chars.splice(49, 15, ...weight);
  chars.splice(185, 1, ...cnpj);
  chars.splice(416, 2, ...group);
  chars.splice(443, 8, ...income);
  return chars.join("");
}
