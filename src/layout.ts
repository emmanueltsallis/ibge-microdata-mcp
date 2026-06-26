export type LayoutVariableType = "string" | "number";

export interface LayoutVariable {
  name: string;
  start: number;
  zeroBasedStart: number;
  width: number;
  type: LayoutVariableType;
  description: string;
  decimals?: number;
}

export type FixedWidthValue = string | number | null;

const SAS_INPUT_LINE =
  /^\s*@(?<start>\d+)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+(?<format>\$?\d+)\.\s*(?:\/\*\s*(?<description>.*?)\s*\*\/)?/;

export function parseSasInputLayout(input: string): LayoutVariable[] {
  const variables: LayoutVariable[] = [];

  for (const line of input.split(/\r?\n/)) {
    const match = SAS_INPUT_LINE.exec(line);
    if (!match?.groups) continue;

    const start = Number.parseInt(match.groups.start, 10);
    const format = match.groups.format;
    const type: LayoutVariableType = format.startsWith("$") ? "string" : "number";
    const width = Number.parseInt(format.replace("$", ""), 10);

    variables.push({
      name: match.groups.name,
      start,
      zeroBasedStart: start - 1,
      width,
      type,
      description: (match.groups.description ?? "").trim(),
    });
  }

  return variables;
}

export function readFixedWidthRecord(
  line: string,
  layout: LayoutVariable[],
  selectedVariables: string[]
): Record<string, FixedWidthValue> {
  const selected = new Set(selectedVariables);
  const record: Record<string, FixedWidthValue> = {};

  for (const variable of layout) {
    if (!selected.has(variable.name)) continue;
    const raw = line.slice(variable.zeroBasedStart, variable.zeroBasedStart + variable.width).trim();
    if (variable.type === "number") {
      const parsed = raw === "" ? null : Number.parseFloat(raw);
      record[variable.name] =
        parsed === null || variable.decimals === undefined || variable.decimals <= 0
          ? parsed
          : parsed / 10 ** variable.decimals;
    } else {
      record[variable.name] = raw;
    }
  }

  return record;
}
