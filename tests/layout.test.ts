import { describe, expect, it } from "vitest";

import { parseSasInputLayout, readFixedWidthRecord } from "../src/layout.js";

describe("parseSasInputLayout", () => {
  it("parses IBGE SAS input lines into fixed-width variable definitions", () => {
    const input = `
@0001 Ano   $4.   /* Ano de referência */
@0186 V4019   $1.   /* Negócio/empresa registrado no CNPJ*/
@0417 VD4009   $2.   /* Posição na ocupação */
@0444 VD4019   8.   /* Rendim. habitual qq trabalho */
`;

    expect(parseSasInputLayout(input)).toEqual([
      {
        name: "Ano",
        start: 1,
        zeroBasedStart: 0,
        width: 4,
        type: "string",
        format: "$4.",
        description: "Ano de referência"
      },
      {
        name: "V4019",
        start: 186,
        zeroBasedStart: 185,
        width: 1,
        type: "string",
        format: "$1.",
        description: "Negócio/empresa registrado no CNPJ"
      },
      {
        name: "VD4009",
        start: 417,
        zeroBasedStart: 416,
        width: 2,
        type: "string",
        format: "$2.",
        description: "Posição na ocupação"
      },
      {
        name: "VD4019",
        start: 444,
        zeroBasedStart: 443,
        width: 8,
        type: "number",
        format: "8.",
        description: "Rendim. habitual qq trabalho"
      }
    ]);
  });

  it("parses broader SAS formats, labels, decimals, and value categories", () => {
    const input = `
proc format;
value $UFFMT
  '11' = 'Rondônia'
  '33' = 'Rio de Janeiro'
;
run;
label RENDA = "Rendimento mensal deflacionado";
@0001 UF      $CHAR2.
@0003 RENDA   COMMA8.2
format UF $UFFMT.;
`;

    expect(parseSasInputLayout(input)).toEqual([
      {
        name: "UF",
        start: 1,
        zeroBasedStart: 0,
        width: 2,
        type: "string",
        format: "$CHAR2.",
        description: "",
        categories: [
          { value: "11", label: "Rondônia" },
          { value: "33", label: "Rio de Janeiro" }
        ]
      },
      {
        name: "RENDA",
        start: 3,
        zeroBasedStart: 2,
        width: 8,
        type: "number",
        format: "COMMA8.2.",
        decimals: 2,
        description: "Rendimento mensal deflacionado"
      }
    ]);
  });
});

describe("readFixedWidthRecord", () => {
  it("extracts selected fixed-width values and parses numeric blanks as null", () => {
    const layout = parseSasInputLayout(`
@0001 Ano   $4.   /* Ano de referência */
@0186 V4019   $1.   /* CNPJ */
@0417 VD4009   $2.   /* Posição */
@0444 VD4019   8.   /* Rendimento */
`);
    const chars = Array.from({ length: 451 }, () => " ");
    chars.splice(0, 4, ..."2024");
    chars.splice(185, 1, ..."1");
    chars.splice(416, 2, ..." 8");
    chars.splice(443, 8, ..."00009190");

    expect(readFixedWidthRecord(chars.join(""), layout, ["Ano", "V4019", "VD4009", "VD4019"])).toEqual({
      Ano: "2024",
      V4019: "1",
      VD4009: "8",
      VD4019: 9190
    });
  });
});
