import { readFile } from "node:fs/promises";
import readline from "node:readline";

import yauzl from "yauzl";

import { parseSasInputLayout } from "./layout.js";
import type { PnadcIncomeSummary } from "./pnadc.js";
import { summarizePnadcLines } from "./pnadc-stream.js";

export interface SummarizePnadcZipFileInput {
  layoutPath: string;
  zipPath: string;
  entryName?: string;
  topPercents: number[];
}

export interface SummarizePnadcZipFileOutput {
  zipEntryName: string;
  rowsRead: number;
  rowsUsed: number;
  summary: PnadcIncomeSummary;
}

export async function summarizePnadcZipFile(
  input: SummarizePnadcZipFileInput
): Promise<SummarizePnadcZipFileOutput> {
  const layoutText = await readFile(input.layoutPath, "utf8");
  const layout = parseSasInputLayout(layoutText);

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    yauzl.open(input.zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        fail(openError ?? new Error("Unable to open ZIP archive"));
        return;
      }

      const finish = (result: SummarizePnadcZipFileOutput) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        resolve(result);
      };

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (!isRequestedDataEntry(entry.fileName, input.entryName)) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, async (streamError, readStream) => {
          if (streamError || !readStream) {
            fail(streamError ?? new Error(`Unable to read ZIP entry: ${entry.fileName}`));
            return;
          }

          try {
            const lines = readline.createInterface({
              input: readStream,
              crlfDelay: Infinity,
            });
            const summary = await summarizePnadcLines(lines, layout, input.topPercents);
            finish({
              zipEntryName: entry.fileName,
              rowsRead: summary.rowsRead,
              rowsUsed: summary.rowsUsed,
              summary: summary.summary,
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      zipfile.on("end", () => {
        const wanted = input.entryName ? `ZIP entry not found: ${input.entryName}` : "No PNAD TXT entry found in ZIP";
        fail(new Error(wanted));
      });
      zipfile.on("error", fail);
    });
  });
}

function isRequestedDataEntry(fileName: string, requestedEntryName: string | undefined): boolean {
  if (fileName.endsWith("/")) return false;
  if (requestedEntryName) return fileName === requestedEntryName;

  const normalized = fileName.toLowerCase();
  return normalized.endsWith(".txt") && normalized.includes("pnadc");
}
