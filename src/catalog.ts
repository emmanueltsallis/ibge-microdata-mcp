export type SurveyId = "pnadc_trimestral" | "pof";

export interface SupportedSurvey {
  id: SurveyId;
  name: string;
  description: string;
  baseUrl: string;
  access: "public_download";
}

export interface DirectoryEntry {
  name: string;
  url: string;
  kind: "file" | "directory";
}

const IBGE_FTP = "https://ftp.ibge.gov.br";

export const PNADC_TRIMESTRAL_MICRODATA_URL =
  `${IBGE_FTP}/Trabalho_e_Rendimento/` +
  "Pesquisa_Nacional_por_Amostra_de_Domicilios_continua/Trimestral/Microdados/";

export const POF_MICRODATA_URL = `${IBGE_FTP}/Orcamentos_Familiares/`;

export function listSupportedSurveys(): SupportedSurvey[] {
  return [
    {
      id: "pnadc_trimestral",
      name: "PNAD Contínua Trimestral",
      description: "Quarterly core PNAD Contínua person/household microdata.",
      baseUrl: PNADC_TRIMESTRAL_MICRODATA_URL,
      access: "public_download",
    },
    {
      id: "pof",
      name: "Pesquisa de Orçamentos Familiares",
      description: "POF edition-level household budget, expenditure, income, and consumption files.",
      baseUrl: POF_MICRODATA_URL,
      access: "public_download",
    },
  ];
}

export function extractDirectoryEntries(html: string, baseUrl: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  const hrefPattern = /href="([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1];
    if (!isDownloadEntry(href)) continue;

    const name = decodeURIComponent(href.split("/").filter(Boolean).at(-1) ?? href);
    entries.push({
      name,
      url: new URL(href, baseUrl).toString(),
      kind: href.endsWith("/") ? "directory" : "file",
    });
  }

  return entries;
}

export function resolvePnadcQuarterlyZip(
  entries: DirectoryEntry[],
  year: number,
  quarter: number
): DirectoryEntry | null {
  const prefix = `PNADC_0${quarter}${year}_`;
  const matches = entries
    .filter((entry) => entry.kind === "file" && entry.name.startsWith(prefix) && entry.name.endsWith(".zip"))
    .sort((a, b) => b.name.localeCompare(a.name));

  return matches[0] ?? null;
}

function isDownloadEntry(href: string): boolean {
  if (href.startsWith("?")) return false;
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href.includes("ftp.ibge.gov.br");
  }
  if (href.startsWith("/")) return false;
  return href.endsWith(".zip") || href.endsWith(".pdf") || href.endsWith(".txt") || href.endsWith(".xls") || href.endsWith("/");
}
