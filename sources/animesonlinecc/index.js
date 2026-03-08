// ============================================================
// sources/animesonlinecc/index.js
//
// Adaptador da fonte animesonlinecc.to.
// Implementa a interface padrão de fonte:
//
//   source.id          string
//   source.name        string
//   source.listAnimes({ page, genres, mode, year })
//   source.getAnime(slug)
//   source.getEpisode(slug)
//   source.search({ q, genres, mode })
//   source.listGenres()
//   source.listRecent({ page })
//   source.getGenreAnimes(slug, { page })
//   source.fetchImage(path)
//   source.setPort(port)
//   source.cleanUrls(obj)
// ============================================================

import {
  parseAnimeList,
  parseTotalPages,
  parseAnimePage,
  parseEpisodePage,
  setParserPort,
} from "./parsers.js";

const BASE = "https://animesonlinecc.to";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// ── HTTP
async function http(url, referer = BASE) {
  // Primeira requisição para pegar o cookie
  const cookieRes = await fetch(BASE, {
    headers: { "User-Agent": UA, "Referer": referer }
  });
  const setCookie = cookieRes.headers.get("set-cookie") || "";
  const cookieMatch = setCookie.match(/(starstruck_[^=]+=\S+?);/);
  const cookie = cookieMatch ? cookieMatch[1] : "";

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cookie": cookie,
    },
  });
  if (!res.ok)
    throw Object.assign(new Error(`Upstream ${res.status}: ${url}`), {
      statusCode: res.status,
    });
  return res.text();
}

// ── Port da API (injetada via setPort)
let API_PORT = 3000;

// ── Normaliza URLs do site para a API (usada pelo cleanUrls do hook onSend)
const ROUTE_MAP = { episodio: "episodios", anime: "animes", genero: "generos" };

function normalizePath(url) {
  if (typeof url !== "string" || !url.startsWith(BASE)) return url;
  let p = url.replace(BASE, "");
  if (
    p.startsWith("/wp-content") ||
    p.startsWith("/img") ||
    /\.(jpg|jpeg|png|webp|gif)$/i.test(p)
  ) {
    return `http://localhost:${API_PORT}/img${p}?source=animesonlinecc`;
  }
  const parts = p.split("/").filter(Boolean);
  if (parts.length > 0 && ROUTE_MAP[parts[0]]) parts[0] = ROUTE_MAP[parts[0]];
  return `http://localhost:${API_PORT}/${parts.join("/")}`;
}

// cleanUrls percorre o objeto e normaliza qualquer URL residual do site
// que não tenha sido tratada pelos parsers (ex.: campos dinâmicos futuros)
export function cleanUrls(obj) {
  if (Array.isArray(obj)) return obj.map(cleanUrls);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k in obj)
      out[k] =
        typeof obj[k] === "string" ? normalizePath(obj[k]) : cleanUrls(obj[k]);
    return out;
  }
  return obj;
}

// ── Busca slugs de uma página de gênero (para filtro AND/OR)
async function fetchGenreSlugs(genreSlug, page = 1) {
  const url =
    page === 1
      ? `${BASE}/genero/${genreSlug}/`
      : `${BASE}/genero/${genreSlug}/page/${page}/`;
  const html = await http(url);
  return new Set(parseAnimeList(html).map((a) => a.slug));
}

// ── Aplica filtro de gêneros sobre uma lista já parseada
async function applyGenreFilter(list, genres, mode, page) {
  const sets = await Promise.all(genres.map((g) => fetchGenreSlugs(g, page)));
  let filterSet;
  if (mode === "AND") {
    const [first, ...rest] = sets;
    filterSet = new Set([...first].filter((s) => rest.every((r) => r.has(s))));
  } else {
    filterSet = new Set(sets.flatMap((s) => [...s]));
  }
  return list.filter((a) => filterSet.has(a.slug));
}

// ════════════════════════════════════════════════════════════
// Fonte: animesonlinecc
// ════════════════════════════════════════════════════════════
const source = {
  id: "animesonlinecc",
  name: "Animes Online CC",

  // Chamado pelo api.js para injetar a porta — propaga para os parsers também
  setPort(port) {
    API_PORT = port;
    setParserPort(port, "animesonlinecc");
  },

  // cleanUrls é chamado pelo hook onSend do api.js para normalizar
  // quaisquer URLs residuais do site que escaparem dos parsers
  cleanUrls,

  // ── Lista de animes com filtros opcionais
  async listAnimes({ page = 1, genres = null, mode = "AND" } = {}) {
    const url = page === 1 ? `${BASE}/anime/` : `${BASE}/anime/page/${page}/`;
    const html = await http(url);
    const totalPages = parseTotalPages(html, /\/anime\/page\/(\d+)\//g);
    let animes = parseAnimeList(html);

    if (genres?.length)
      animes = await applyGenreFilter(animes, genres, mode, page);

    return { page, totalPages, count: animes.length, animes };
  },

  // ── Detalhe de um anime
  async getAnime(slug) {
    const html = await http(`${BASE}/anime/${slug}/`);
    return parseAnimePage(html, slug);
  },

  // ── Detalhe de um episódio
  async getEpisode(slug) {
    const html = await http(`${BASE}/episodio/${slug}/`, `${BASE}/`);
    return parseEpisodePage(html, slug);
  },

  // ── Busca textual com filtros opcionais
  async search({ q, genres = null, mode = "AND" } = {}) {
    const html = await http(`${BASE}/?s=${encodeURIComponent(q)}`);
    let animes = parseAnimeList(html);

    // Episódios encontrados na busca
    const epRe =
      /href="(https?:\/\/animesonlinecc\.to\/episodio\/([^/"]+)\/?)"/gi;
    const epSeen = new Set();
    const episodes = [];
    let em;
    while ((em = epRe.exec(html)) !== null) {
      if (!epSeen.has(em[2])) {
        epSeen.add(em[2]);
        episodes.push({
          slug: em[2],
          url: `http://localhost:${API_PORT}/episodios/${em[2]}`,
        });
      }
    }

    if (genres?.length) animes = await applyGenreFilter(animes, genres, mode);
    return { animes, episodes, ...(genres ? { genres, mode } : {}) };
  },

  // ── Lista de gêneros
  async listGenres() {
    const html = await http(`${BASE}/anime/`);
    const re =
      /href="https?:\/\/animesonlinecc\.to\/genero\/([^/"]+)\/?">([^<]+)<\/a>/gi;
    const seen = new Set();
    const generos = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        generos.push({
          slug: m[1],
          name: m[2].trim(),
          url: `http://localhost:${API_PORT}/generos/${m[1]}`,
        });
      }
    }
    return { count: generos.length, generos };
  },

  // ── Episódios recentes
  async listRecent({ page = 1 } = {}) {
    const url = page === 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
    const html = await http(url);
    const re =
      /href="(https?:\/\/animesonlinecc\.to\/episodio\/([^/"]+)-episodio-(\d+)\/?)"[^>]*>([^<]*)/gi;
    const seen = new Set();
    const episodes = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const epSlug = m[2] + "-episodio-" + m[3];
      if (seen.has(epSlug)) continue;
      seen.add(epSlug);
      episodes.push({
        slug: epSlug,
        animeSlug: m[2],
        epNumber: parseInt(m[3]),
        url: `http://localhost:${API_PORT}/episodios/${epSlug}`,
        label: m[4].trim() || null,
      });
    }
    return { page, count: episodes.length, episodes };
  },

  // ── Animes de um gênero específico
  async getGenreAnimes(slug, { page = 1 } = {}) {
    const url =
      page === 1
        ? `${BASE}/genero/${slug}/`
        : `${BASE}/genero/${slug}/page/${page}/`;
    const html = await http(url);
    const totalPages = parseTotalPages(
      html,
      new RegExp(`/genero/${slug}/page/(\\d+)/`, "g"),
    );
    const animes = parseAnimeList(html);
    return { genre: slug, page, totalPages, count: animes.length, animes };
  },

  // ── Proxy de imagem (retorna buffer + content-type)
  async fetchImage(path) {
    const url = `${BASE}/${path}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: BASE },
    });
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "image/jpeg",
    };
  },
};

export default source;
