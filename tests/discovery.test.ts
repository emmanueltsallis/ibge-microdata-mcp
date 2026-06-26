import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverMicrodataFiles } from "../src/discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverMicrodataFiles", () => {
  it("crawls official IBGE directories to find microdata directories and downloadable files", async () => {
    const pages: Record<string, string> = {
      "https://ftp.ibge.gov.br/root/": '<a href="Pesquisa_A/">Pesquisa A</a><a href="Notas.txt">Notas</a>',
      "https://ftp.ibge.gov.br/root/Pesquisa_A/": '<a href="Microdados/">Microdados</a><a href="Tabelas/">Tabelas</a>',
      "https://ftp.ibge.gov.br/root/Pesquisa_A/Microdados/":
        '<a href="Dados.zip">Dados</a><a href="Documentacao.zip">Documentacao</a>',
      "https://ftp.ibge.gov.br/root/Pesquisa_A/Tabelas/": '<a href="Tabela.zip">Tabela</a>',
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(pages[url] ?? "", { status: pages[url] ? 200 : 404 }))
    );

    const result = await discoverMicrodataFiles({
      rootUrl: "https://ftp.ibge.gov.br/root/",
      maxDepth: 3,
      maxDirectories: 10,
    });

    expect(result.directoriesVisited).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.matches.map((match) => match.url)).toEqual([
      "https://ftp.ibge.gov.br/root/Pesquisa_A/Microdados/",
      "https://ftp.ibge.gov.br/root/Pesquisa_A/Microdados/Dados.zip",
      "https://ftp.ibge.gov.br/root/Pesquisa_A/Microdados/Documentacao.zip",
    ]);
  });

  it("stops crawling when maxDirectories is reached", async () => {
    const pages: Record<string, string> = {
      "https://ftp.ibge.gov.br/root/": '<a href="A/">A</a><a href="B/">B</a>',
      "https://ftp.ibge.gov.br/root/A/": '<a href="Microdados/">Microdados</a>',
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(pages[url] ?? "", { status: pages[url] ? 200 : 404 }))
    );

    const result = await discoverMicrodataFiles({
      rootUrl: "https://ftp.ibge.gov.br/root/",
      maxDepth: 3,
      maxDirectories: 1,
    });

    expect(result.directoriesVisited).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it("rejects non-official roots", async () => {
    await expect(
      discoverMicrodataFiles({
        rootUrl: "https://example.com/root/",
      })
    ).rejects.toThrow("Only ftp.ibge.gov.br URLs are supported");
  });
});
