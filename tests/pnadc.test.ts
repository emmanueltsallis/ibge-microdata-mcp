import { describe, expect, it } from "vitest";

import { classifyPnadcWorkGroup, summarizePnadcIncomeGroups } from "../src/pnadc.js";

describe("classifyPnadcWorkGroup", () => {
  it("maps PNAD derived occupation and CNPJ variables into economist-friendly groups", () => {
    expect(classifyPnadcWorkGroup({ VD4009: "1", V4019: "" })).toBe("employee");
    expect(classifyPnadcWorkGroup({ VD4009: "7", V4019: "" })).toBe("employee");
    expect(classifyPnadcWorkGroup({ VD4009: "8", V4019: "1" })).toBe("employer_with_cnpj");
    expect(classifyPnadcWorkGroup({ VD4009: "8", V4019: "2" })).toBe("employer_without_cnpj");
    expect(classifyPnadcWorkGroup({ VD4009: "9", V4019: "1" })).toBe("own_account");
  });
});

describe("summarizePnadcIncomeGroups", () => {
  it("computes weighted group shares, mean income, and top-bracket composition", () => {
    const summary = summarizePnadcIncomeGroups(
      [
        { V1028: 80, VD4009: "1", V4019: "", VD4019: 1000 },
        { V1028: 10, VD4009: "8", V4019: "2", VD4019: 5000 },
        { V1028: 10, VD4009: "8", V4019: "1", VD4019: 10000 }
      ],
      [0.1, 0.2]
    );

    expect(summary.totalWeight).toBe(100);
    expect(summary.groups.employee).toMatchObject({
      weight: 80,
      populationShare: 0.8,
      meanIncome: 1000
    });
    expect(summary.groups.employer_with_cnpj).toMatchObject({
      weight: 10,
      populationShare: 0.1,
      meanIncome: 10000
    });
    expect(summary.topBrackets.top10.groupWeightShares).toEqual({
      employee: 0,
      employer_with_cnpj: 1,
      employer_without_cnpj: 0,
      own_account: 0,
      other: 0
    });
    expect(summary.topBrackets.top20.groupWeightShares).toEqual({
      employee: 0,
      employer_with_cnpj: 0.5,
      employer_without_cnpj: 0.5,
      own_account: 0,
      other: 0
    });
  });

  it("allocates tied cutoff-income buckets proportionally across work groups", () => {
    const summary = summarizePnadcIncomeGroups(
      [
        { V1028: 10, VD4009: "1", V4019: "", VD4019: 1000 },
        { V1028: 10, VD4009: "8", V4019: "1", VD4019: 1000 }
      ],
      [0.5]
    );

    expect(summary.topBrackets.top50.groupWeightShares).toEqual({
      employee: 0.5,
      employer_with_cnpj: 0.5,
      employer_without_cnpj: 0,
      own_account: 0,
      other: 0
    });
  });
});
