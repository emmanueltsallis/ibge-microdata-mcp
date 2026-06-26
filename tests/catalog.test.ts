import { describe, expect, it } from "vitest";

import {
  extractDirectoryEntries,
  listSupportedSurveys,
  resolvePnadcQuarterlyZip
} from "../src/catalog.js";

describe("listSupportedSurveys", () => {
  it("starts with PNAD Contínua and POF microdata families", () => {
    expect(listSupportedSurveys().map((survey) => survey.id)).toEqual(["pnadc_trimestral", "pof"]);
  });
});

describe("extractDirectoryEntries", () => {
  it("extracts IBGE download directory hrefs and filters social/footer links", () => {
    const html = `
<a href="?C=N;O=D">Name</a>
<a href="/Trabalho_e_Rendimento/Pesquisa_Nacional_por_Amostra_de_Domicilios_continua/Trimestral/Microdados/">Parent</a>
<a href="PNADC_012024_20250815.zip">PNADC_012024_20250815.zip</a>
<a href="PNADC_042024_20250815.zip">PNADC_042024_20250815.zip</a>
<a href="https://www.ibge.gov.br/">IBGE</a>
`;

    expect(extractDirectoryEntries(html, "https://ftp.ibge.gov.br/base/")).toEqual([
      {
        name: "PNADC_012024_20250815.zip",
        url: "https://ftp.ibge.gov.br/base/PNADC_012024_20250815.zip",
        kind: "file"
      },
      {
        name: "PNADC_042024_20250815.zip",
        url: "https://ftp.ibge.gov.br/base/PNADC_042024_20250815.zip",
        kind: "file"
      }
    ]);
  });
});

describe("resolvePnadcQuarterlyZip", () => {
  it("picks the requested quarter and newest publication suffix", () => {
    const entries = [
      {
        name: "PNADC_042024_20240101.zip",
        url: "https://example.test/old.zip",
        kind: "file" as const
      },
      {
        name: "PNADC_042024_20250815.zip",
        url: "https://example.test/new.zip",
        kind: "file" as const
      },
      {
        name: "PNADC_032024_20250815.zip",
        url: "https://example.test/q3.zip",
        kind: "file" as const
      }
    ];

    expect(resolvePnadcQuarterlyZip(entries, 2024, 4)).toEqual(entries[1]);
  });
});
