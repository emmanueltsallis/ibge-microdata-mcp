import type { LayoutVariable } from "./layout.js";
import { readFixedWidthRecord } from "./layout.js";
import {
  addPnadcIncomeRecord,
  createPnadcIncomeAccumulator,
  finishPnadcIncomeSummary,
  type PnadcIncomeSummary,
} from "./pnadc.js";

export interface SummarizePnadcLinesOutput {
  rowsRead: number;
  rowsUsed: number;
  summary: PnadcIncomeSummary;
}

const REQUIRED_VARIABLES = ["V1028", "VD4009", "V4019", "VD4019"];

export async function summarizePnadcLines(
  lines: AsyncIterable<string>,
  layout: LayoutVariable[],
  topPercents: number[]
): Promise<SummarizePnadcLinesOutput> {
  const accumulator = createPnadcIncomeAccumulator();
  let rowsRead = 0;
  let rowsUsed = 0;

  for await (const line of lines) {
    if (line.trim() === "") continue;
    rowsRead += 1;
    const parsed = readFixedWidthRecord(line, layout, REQUIRED_VARIABLES);
    const wasUsed = addPnadcIncomeRecord(accumulator, {
      V1028: parsed.V1028,
      VD4009: parsed.VD4009,
      V4019: parsed.V4019,
      VD4019: parsed.VD4019,
    });
    if (wasUsed) rowsUsed += 1;
  }

  return {
    rowsRead,
    rowsUsed,
    summary: finishPnadcIncomeSummary(accumulator, topPercents),
  };
}
