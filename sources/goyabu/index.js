// ============================================================
// sources/goyabu/index.js
//
// Adaptador da fonte goyabu.io
// Implementa a interface padrão de fonte.
//
// Particularidades do goyabu.io:
//   - Episódios acessados por ID numérico: /55106
//   - Lista de animes via /lista-de-animes?l=todos ou /?s=
//   - allEpisodes embutido no HTML do anime como JS inline
//   - API REST: /wp-json/animeonline/search/?s=
//   - Gêneros: /generos e /generos/<slug>
//   - Recentes: / (home), /lancamentos, /page/N
// ============================================================

import {
  parseAnimePage,
  parseEpisodePage,
  parseAnimeList,
  parseTotalPages,
  parseGenreList,
  parseRecentEpisodes,
  setParserPort,
  n,
} from "./parsers.js";

const BASE = "https://goyabu.io";
const UA   =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

let API_PORT = 3000;
let _base    = process.env.API_BASE_URL?.replace(/\/$/, "") || `${_base}`;

// ── HTTP helper
async function http(url, referer = BASE) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: referer,
      "Accept-Language": "pt-BR,pt;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok)
    throw Object.assign(new Error(`Upstream ${res.status}: ${url}`), { statusCode: res.status });
  return res.text();
}

// ── cleanUrls — segunda linha de defesa para URLs residuais do site
function normalizePath(url) {
  if (typeof url !== "string" || !url) return url;
  if (url.startsWith("/wp-content") || url.startsWith("/miniatures"))
    return `${_base}/img${url}`;
  if (url.startsWith(BASE + "/wp-content") || url.startsWith(BASE + "/miniatures"))
    return `${_base}/img${url.replace(BASE, "")}`;
  if (url.includes("myblogapi.site/storage"))
    return `${_base}/img/external${url.replace("https://api.myblogapi.site", "")}?source=goyabu`;
  if (url.startsWith(BASE + "/anime/"))
    return `${_base}/animes/${url.replace(BASE + "/anime/", "")}`;
  if (/^https?:\/\/goyabu\.io\/\d+\/?$/.test(url))
    return `${_base}/episodios/${url.replace(/.*\/(\d+)\/?$/, "$1")}`;
  if (url.startsWith(BASE + "/generos/"))
    return `${_base}${url.replace(BASE, "")}`;
  return url;
}

function cleanUrls(obj) {
  if (Array.isArray(obj)) return obj.map(cleanUrls);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k in obj)
      out[k] = typeof obj[k] === "string" ? normalizePath(obj[k]) : cleanUrls(obj[k]);
    return out;
  }
  return obj;
}

// ── Busca slugs de uma página de gênero para filtro AND/OR
async function fetchGenreSlugs(genreSlug, page = 1) {
  const url =
    page === 1
      ? `${BASE}/generos/${genreSlug}`
      : `${BASE}/generos/${genreSlug}/page/${page}`;
  const html = await http(url);
  return new Set(parseAnimeList(html).map((a) => a.slug));
}

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
// Fonte: goyabu
// ════════════════════════════════════════════════════════════
const source = {
  id:   "goyabu",
  name: "Goyabu",

  setPort(port) {
    API_PORT = port;
    _base    = process.env.API_BASE_URL?.replace(/\/$/, "") || `http://localhost:${port}`;
    setParserPort(port, "goyabu");
  },

  cleanUrls,

  // ── Lista de animes
  // O goyabu não tem uma lista paginada simples — usa /lista-de-animes?l=todos
  // que renderiza tudo via JS. Alternativa: paginação da home /?page=N
  // ou filtrar por gênero. Usamos a home paginada como listagem principal.
  async listAnimes({ page = 1, genres = null, mode = "AND" } = {}) {
    const url = page === 1 ? `${BASE}/` : `${BASE}/page/${page}`;
    const html = await http(url);

    // Paginação da home: <link rel="next" href="https://goyabu.io/page/2" />
    const totalPagesM = [...html.matchAll(/\/page\/(\d+)/g)].map((m) => parseInt(m[1]));
    const totalPages  = totalPagesM.length ? Math.max(...totalPagesM) : 1;

    let animes = parseAnimeList(html);
    if (genres?.length) animes = await applyGenreFilter(animes, genres, mode, page);

    return { page, totalPages, count: animes.length, animes };
  },

  // ── Detalhe do anime
  async getAnime(slug) {
    const html = await http(`${BASE}/anime/${slug}`);
    return parseAnimePage(html, slug);
  },

  // ── Detalhe do episódio (por ID numérico)
  async getEpisode(id) {
    const html = await http(`${BASE}/${id}`, `${BASE}/`);
    return parseEpisodePage(html, id);
  },

  // ── Busca — usa a API REST do tema quando disponível, fallback para ?s=
  async search({ q, genres = null, mode = "AND" } = {}) {
    // REST API do tema (retorna JSON com lista de animes)
    let animes = [];
    try {
      const apiUrl = `${BASE}/wp-json/animeonline/search/?s=${encodeURIComponent(q)}`;
      const res = await fetch(apiUrl, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        // Resposta pode ser array de posts ou objeto com .posts
        const posts = Array.isArray(data) ? data : data.posts || data.results || [];
        animes = posts.map((p) => ({
          slug:  p.slug || p.post_name || "",
          title: p.title?.rendered || p.post_title || p.name || "",
          url:   `${_base}/animes/${p.slug || p.post_name || ""}`,
          cover: p.thumbnail ? n(p.thumbnail) : null,
        })).filter((a) => a.slug);
      }
    } catch {}

    // Fallback: scraping do HTML de busca
    if (animes.length === 0) {
      const html = await http(`${BASE}/?s=${encodeURIComponent(q)}`);
      animes = parseAnimeList(html);
    }

    if (genres?.length) animes = await applyGenreFilter(animes, genres, mode);
    return { animes, ...(genres ? { genres, mode } : {}) };
  },

  // ── Lista de gêneros — extrai da página /generos
  async listGenres() {
    const html   = await http(`${BASE}/generos`);
    const genres = parseGenreList(html);
    return { count: genres.length, generos: genres };
  },

  // ── Animes de um gênero
  async getGenreAnimes(slug, { page = 1 } = {}) {
    const url =
      page === 1
        ? `${BASE}/generos/${slug}`
        : `${BASE}/generos/${slug}/page/${page}`;
    const html = await http(url);
    const totalPages = parseTotalPages(
      html,
      new RegExp(`/generos/${slug}/page/(\\d+)`, "g"),
    );
    const animes = parseAnimeList(html);
    return { genre: slug, page, totalPages, count: animes.length, animes };
  },

  // ── Episódios recentes — home paginada + /lancamentos
  async listRecent({ page = 1 } = {}) {
    // /lancamentos tem os lançamentos mais recentes (página 1)
    // Para páginas seguintes, usa / paginada
    const url = page === 1 ? `${BASE}/lancamentos` : `${BASE}/page/${page}`;
    const html = await http(url);
    const episodes = parseRecentEpisodes(html);
    return { page, count: episodes.length, episodes };
  },

  // ── Proxy de imagem
  // Suporta dois caminhos:
  //   /img/wp-content/... → goyabu.io/wp-content/...
  //   /img/miniatures/... → goyabu.io/miniatures/...
  //   /img/external/...   → api.myblogapi.site/...
  async fetchImage(path) {
    let url;
    if (path.startsWith("external/")) {
      url = `https://api.myblogapi.site/${path.replace("external/", "")}`;
    } else {
      url = `${BASE}/${path}`;
    }
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: BASE } });
    return {
      buffer:      Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "image/webp",
    };
  },
};

export default source;