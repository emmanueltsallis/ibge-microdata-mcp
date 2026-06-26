import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractZipEntry, listZipEntries } from "../src/zip.js";

const execFileAsync = promisify(execFile);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "ibge-zip-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("zip helpers", () => {
  it("lists entries and extracts one file from a ZIP archive", async () => {
    const inputPath = path.join(tempDir, "input_PNADC_trimestral.txt");
    const zipPath = path.join(tempDir, "doc.zip");
    const outputPath = path.join(tempDir, "out", "input.txt");
    await writeFile(inputPath, "@0001 Ano $4. /* Ano */\n");
    await execFileAsync("zip", ["-j", zipPath, inputPath]);

    await expect(listZipEntries(zipPath)).resolves.toEqual([
      {
        fileName: "input_PNADC_trimestral.txt",
        compressedSize: expect.any(Number),
        uncompressedSize: 24
      }
    ]);

    const result = await extractZipEntry(zipPath, "input_PNADC_trimestral.txt", outputPath);
    expect(result).toEqual({
      fileName: "input_PNADC_trimestral.txt",
      outputPath,
      bytesWritten: 24
    });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("@0001 Ano $4. /* Ano */\n");
  });
});
