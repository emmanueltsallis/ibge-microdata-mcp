import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import readline from "node:readline";

import { parseSasInputLayout } from "./layout.js";
import type { PnadcIncomeSummary } from "./pnadc.js";
import { summarizePnadcLines } from "./pnadc-stream.js";

export interface SummarizePnadcTextFileInput {
  layoutPath: string;
  dataPath: string;
  topPercents: number[];
}

export interface SummarizePnadcTextFileOutput {
  rowsRead: number;
  rowsUsed: number;
  summary: PnadcIncomeSummary;
}

export async function summarizePnadcTextFile(
  input: SummarizePnadcTextFileInput
): Promise<SummarizePnadcTextFileOutput> {
  const layoutText = await readFile(input.layoutPath, "utf8");
  const layout = parseSasInputLayout(layoutText);
  const lines = readline.createInterface({
    input: createReadStream(input.dataPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  return summarizePnadcLines(lines, layout, input.topPercents);
}
