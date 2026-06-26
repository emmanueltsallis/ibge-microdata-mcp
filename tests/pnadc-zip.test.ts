import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { summarizePnadcZipFile } from "../src/pnadc-zip.js";

const execFileAsync = promisify(execFile);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-pnadc-zip-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("summarizePnadcZipFile", () => {
  it("streams a fixed-width PNAD text entry directly from a ZIP archive", async () => {
    const layoutPath = path.join(tempDir, "input.txt");
    const dataPath = path.join(tempDir, "PNADC_sample.txt");
    const zipPath = path.join(tempDir, "PNADC_sample.zip");
    await writeFile(
      layoutPath,
      `
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
    await execFileAsync("zip", ["-j", zipPath, dataPath]);

    const result = await summarizePnadcZipFile({
      layoutPath,
      zipPath,
      entryName: "PNADC_sample.txt",
      topPercents: [0.1]
    });

    expect(result.rowsRead).toBe(2);
    expect(result.zipEntryName).toBe("PNADC_sample.txt");
    expect(result.summary.groups.employer_with_cnpj.weight).toBe(10);
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
  chars.splice(49, 15, ...weight);
  chars.splice(185, 1, ...cnpj);
  chars.splice(416, 2, ...group);
  chars.splice(443, 8, ...income);
  return chars.join("");
}
