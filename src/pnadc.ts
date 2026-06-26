export type PnadcWorkGroup =
  | "employee"
  | "employer_with_cnpj"
  | "employer_without_cnpj"
  | "own_account"
  | "other";

export interface PnadcAnalysisRecord {
  V1028: number | string | null;
  VD4009: number | string | null;
  V4019: number | string | null;
  VD4019: number | string | null;
}

export interface PnadcGroupSummary {
  weight: number;
  populationShare: number;
  incomeMass: number;
  incomeMassShare: number;
  meanIncome: number | null;
}

export interface PnadcTopBracketSummary {
  topPercent: number;
  weight: number;
  incomeMass: number;
  cutoffIncome: number | null;
  groupWeightShares: Record<PnadcWorkGroup, number>;
}

export interface PnadcIncomeSummary {
  totalWeight: number;
  totalIncomeMass: number;
  groups: Record<PnadcWorkGroup, PnadcGroupSummary>;
  topBrackets: Record<string, PnadcTopBracketSummary>;
}

export interface PnadcIncomeAccumulator {
  totalWeight: number;
  totalIncomeMass: number;
  groups: Record<PnadcWorkGroup, PnadcGroupSummary>;
  incomeBuckets: Map<number, Record<PnadcWorkGroup, number>>;
}

const GROUPS: PnadcWorkGroup[] = [
  "employee",
  "employer_with_cnpj",
  "employer_without_cnpj",
  "own_account",
  "other",
];

export function classifyPnadcWorkGroup(record: Pick<PnadcAnalysisRecord, "VD4009" | "V4019">): PnadcWorkGroup {
  const occupation = stringValue(record.VD4009);
  const hasCnpj = stringValue(record.V4019);

  if (["1", "2", "3", "4", "5", "6", "7"].includes(occupation)) return "employee";
  if (occupation === "8" && hasCnpj === "1") return "employer_with_cnpj";
  if (occupation === "8" && hasCnpj === "2") return "employer_without_cnpj";
  if (occupation === "9") return "own_account";
  return "other";
}

export function summarizePnadcIncomeGroups(
  records: PnadcAnalysisRecord[],
  topPercents: number[]
): PnadcIncomeSummary {
  const accumulator = createPnadcIncomeAccumulator();
  for (const record of records) {
    addPnadcIncomeRecord(accumulator, record);
  }

  return finishPnadcIncomeSummary(accumulator, topPercents);
}

export function createPnadcIncomeAccumulator(): PnadcIncomeAccumulator {
  return {
    totalWeight: 0,
    totalIncomeMass: 0,
    groups: emptyGroupSummaries(),
    incomeBuckets: new Map(),
  };
}

export function addPnadcIncomeRecord(
  accumulator: PnadcIncomeAccumulator,
  record: PnadcAnalysisRecord
): boolean {
  const row = toUsableIncomeRow(record);
  if (!row) return false;

  accumulator.totalWeight += row.weight;
  accumulator.totalIncomeMass += row.weight * row.income;

  const groupSummary = accumulator.groups[row.group];
  groupSummary.weight += row.weight;
  groupSummary.incomeMass += row.weight * row.income;

  const bucket = getIncomeBucket(accumulator, row.income);
  bucket[row.group] += row.weight;

  return true;
}

export function finishPnadcIncomeSummary(
  accumulator: PnadcIncomeAccumulator,
  topPercents: number[]
): PnadcIncomeSummary {
  for (const group of GROUPS) {
    const summary = accumulator.groups[group];
    summary.populationShare = safeDivide(summary.weight, accumulator.totalWeight);
    summary.incomeMassShare = safeDivide(summary.incomeMass, accumulator.totalIncomeMass);
    summary.meanIncome = summary.weight === 0 ? null : summary.incomeMass / summary.weight;
  }

  const topBrackets: Record<string, PnadcTopBracketSummary> = {};
  for (const topPercent of topPercents) {
    topBrackets[topKey(topPercent)] = summarizeTopBracket(accumulator, topPercent);
  }

  return {
    totalWeight: accumulator.totalWeight,
    totalIncomeMass: accumulator.totalIncomeMass,
    groups: accumulator.groups,
    topBrackets,
  };
}

function toUsableIncomeRow(record: PnadcAnalysisRecord): {
  group: PnadcWorkGroup;
  weight: number;
  income: number;
} | null {
  const weight = numericValue(record.V1028);
  const income = numericValue(record.VD4019);

  if (weight === null || weight <= 0 || income === null || income < 0) return null;

  return {
    group: classifyPnadcWorkGroup(record),
    weight,
    income,
  };
}

function summarizeTopBracket(accumulator: PnadcIncomeAccumulator, topPercent: number): PnadcTopBracketSummary {
  if (topPercent <= 0 || topPercent > 1) {
    throw new Error("topPercent must be greater than 0 and less than or equal to 1");
  }

  const targetWeight = accumulator.totalWeight * topPercent;
  const sortedBuckets = [...accumulator.incomeBuckets.entries()].sort(([incomeA], [incomeB]) => incomeB - incomeA);
  const groupWeights: Record<PnadcWorkGroup, number> = Object.fromEntries(
    GROUPS.map((group) => [group, 0])
  ) as Record<PnadcWorkGroup, number>;

  let remaining = targetWeight;
  let incomeMass = 0;
  let cutoffIncome: number | null = null;

  for (const [income, bucket] of sortedBuckets) {
    if (remaining <= 0) break;
    const bucketWeight = sum(GROUPS.map((group) => bucket[group]));
    if (bucketWeight <= 0) continue;

    const includedWeight = Math.min(bucketWeight, remaining);
    const inclusionRate = includedWeight / bucketWeight;
    for (const group of GROUPS) {
      groupWeights[group] += bucket[group] * inclusionRate;
    }
    incomeMass += includedWeight * income;
    cutoffIncome = income;
    remaining -= includedWeight;
  }

  const weight = targetWeight - Math.max(remaining, 0);
  const groupWeightShares = Object.fromEntries(
    GROUPS.map((group) => [group, safeDivide(groupWeights[group], weight)])
  ) as Record<PnadcWorkGroup, number>;

  return { topPercent, weight, incomeMass, cutoffIncome, groupWeightShares };
}

function emptyGroupSummaries(): Record<PnadcWorkGroup, PnadcGroupSummary> {
  return Object.fromEntries(
    GROUPS.map((group) => [
      group,
      { weight: 0, populationShare: 0, incomeMass: 0, incomeMassShare: 0, meanIncome: null },
    ])
  ) as Record<PnadcWorkGroup, PnadcGroupSummary>;
}

function getIncomeBucket(
  accumulator: PnadcIncomeAccumulator,
  income: number
): Record<PnadcWorkGroup, number> {
  const existing = accumulator.incomeBuckets.get(income);
  if (existing) return existing;

  const bucket = emptyGroupWeights();
  accumulator.incomeBuckets.set(income, bucket);
  return bucket;
}

function emptyGroupWeights(): Record<PnadcWorkGroup, number> {
  return Object.fromEntries(GROUPS.map((group) => [group, 0])) as Record<PnadcWorkGroup, number>;
}

function numericValue(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: number | string | null): string {
  if (value === null) return "";
  return String(value).trim();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function topKey(topPercent: number): string {
  return `top${Math.round(topPercent * 100)}`;
}
