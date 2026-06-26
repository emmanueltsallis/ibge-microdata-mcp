export type LayoutVariableType = "string" | "number";

export interface ValueLabel {
  value: string;
  label: string;
}

export interface LayoutVariable {
  name: string;
  start: number;
  zeroBasedStart: number;
  width: number;
  type: LayoutVariableType;
  description: string;
  format?: string;
  decimals?: number;
  categories?: ValueLabel[];
}

export type FixedWidthValue = string | number | null;

const SAS_INPUT_LINE =
  /^\s*@(?<start>\d+)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+(?<format>\$?[A-Za-z_]*\d+(?:\.\d*)?)\.?\s*(?:\/\*\s*(?<description>.*?)\s*\*\/)?/;

export function parseSasInputLayout(input: string): LayoutVariable[] {
  const variables: LayoutVariable[] = [];
  const labels = parseSasLabels(input);
  const categoriesByVariable = parseSasCategoriesByVariable(input);

  for (const line of input.split(/\r?\n/)) {
    const match = SAS_INPUT_LINE.exec(line);
    if (!match?.groups) continue;

    const start = Number.parseInt(match.groups.start, 10);
    const format = normalizeSasFormat(match.groups.format);
    const parsedFormat = parseSasFormat(format);
    if (!parsedFormat) continue;

    const description = ((match.groups.description ?? labels.get(match.groups.name)) ?? "").trim();
    const categories = categoriesByVariable.get(match.groups.name);

    variables.push({
      name: match.groups.name,
      start,
      zeroBasedStart: start - 1,
      width: parsedFormat.width,
      type: parsedFormat.type,
      description,
      format,
      ...(parsedFormat.decimals === undefined ? {} : { decimals: parsedFormat.decimals }),
      ...(categories && categories.length > 0 ? { categories } : {}),
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

function normalizeSasFormat(format: string): string {
  return format.endsWith(".") ? format : `${format}.`;
}

function parseSasFormat(format: string): { width: number; decimals?: number; type: LayoutVariableType } | null {
  const withoutTrailingDot = format.replace(/\.$/, "");
  const numericMatch = /(?<width>\d+)(?:\.(?<decimals>\d+))?$/.exec(withoutTrailingDot);
  if (!numericMatch?.groups) return null;

  const width = Number.parseInt(numericMatch.groups.width, 10);
  const decimals =
    numericMatch.groups.decimals === undefined ? undefined : Number.parseInt(numericMatch.groups.decimals, 10);
  const type = withoutTrailingDot.startsWith("$") || /\bCHAR/i.test(withoutTrailingDot) ? "string" : "number";
  return {
    width,
    type,
    ...(decimals === undefined || type === "string" ? {} : { decimals }),
  };
}

function parseSasLabels(input: string): Map<string, string> {
  const labels = new Map<string, string>();
  const labelBlocks = input.matchAll(/\blabel\b(?<body>[\s\S]*?);/gi);
  for (const block of labelBlocks) {
    const body = block.groups?.body ?? "";
    for (const match of body.matchAll(/\b(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'](?<label>[^"']+)["']/g)) {
      if (match.groups) labels.set(match.groups.name, match.groups.label.trim());
    }
  }
  return labels;
}

function parseSasCategoriesByVariable(input: string): Map<string, ValueLabel[]> {
  const categoriesByFormat = parseSasValueFormats(input);
  if (categoriesByFormat.size === 0) return new Map();

  const categoriesByVariable = new Map<string, ValueLabel[]>();
  for (const [variableName, formatName] of parseSasFormatAssignments(input)) {
    const categories = categoriesByFormat.get(normalizeFormatName(formatName));
    if (categories && categories.length > 0) {
      categoriesByVariable.set(variableName, categories);
    }
  }
  return categoriesByVariable;
}

function parseSasValueFormats(input: string): Map<string, ValueLabel[]> {
  const formats = new Map<string, ValueLabel[]>();
  for (const block of input.matchAll(/\bvalue\s+(?<format>\$?[A-Za-z_][A-Za-z0-9_]*)\s+(?<body>[\s\S]*?);/gi)) {
    const formatName = normalizeFormatName(block.groups?.format ?? "");
    const body = block.groups?.body ?? "";
    const categories: ValueLabel[] = [];

    for (const match of body.matchAll(/['"]?(?<value>[^'"=\s]+)['"]?\s*=\s*["'](?<label>[^"']+)["']/g)) {
      if (!match.groups) continue;
      categories.push({
        value: match.groups.value.trim(),
        label: match.groups.label.trim(),
      });
    }

    if (formatName !== "" && categories.length > 0) {
      formats.set(formatName, categories);
    }
  }
  return formats;
}

function parseSasFormatAssignments(input: string): Array<[string, string]> {
  const assignments: Array<[string, string]> = [];
  for (const block of input.matchAll(/\b(?:format|informat)\b(?<body>[\s\S]*?);/gi)) {
    const tokens = (block.groups?.body ?? "").trim().split(/\s+/).filter(Boolean);
    for (let index = 0; index < tokens.length - 1; index += 2) {
      const variableName = tokens[index];
      const formatName = tokens[index + 1];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName) && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(formatName)) {
        assignments.push([variableName, formatName]);
      }
    }
  }
  return assignments;
}

function normalizeFormatName(formatName: string): string {
  return formatName.replace(/\.$/, "").toLowerCase();
}
