import { readFile } from "node:fs/promises";

import { parseSasInputLayout, type LayoutVariable } from "./layout.js";

export interface InspectLayoutInput {
  layoutPath: string;
  search?: string;
  limit?: number;
}

export interface InspectLayoutVariable {
  name: string;
  start: number;
  width: number;
  type: LayoutVariable["type"];
  description: string;
}

export interface InspectLayoutOutput {
  layoutPath: string;
  totalVariables: number;
  returnedVariables: number;
  variables: InspectLayoutVariable[];
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function inspectLayout(input: InspectLayoutInput): Promise<InspectLayoutOutput> {
  const layoutText = await readFile(input.layoutPath, "utf8");
  const variables = parseSasInputLayout(layoutText);
  const search = input.search?.trim().toLowerCase();
  const limit = normalizeLimit(input.limit);

  const filtered = search
    ? variables.filter((variable) => variableMatchesSearch(variable, search))
    : variables;
  const returned = filtered.slice(0, limit).map(toInspectVariable);

  return {
    layoutPath: input.layoutPath,
    totalVariables: variables.length,
    returnedVariables: returned.length,
    variables: returned,
  };
}

function variableMatchesSearch(variable: LayoutVariable, search: string): boolean {
  return variable.name.toLowerCase().includes(search) || variable.description.toLowerCase().includes(search);
}

function toInspectVariable(variable: LayoutVariable): InspectLayoutVariable {
  return {
    name: variable.name,
    start: variable.start,
    width: variable.width,
    type: variable.type,
    description: variable.description,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}
