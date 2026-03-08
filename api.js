// ============================================================
// Anify API  v2.1
// Instalar: bun add fastify @fastify/cors
// Rodar:    bun api.js
//
// Novidades v2.1:
//   - Rotas sem ?source= consultam TODAS as fontes em paralelo
//   - Deduplicação por similaridade de título (≥85%) entre sources
//   - ?source=id força uma fonte específica
//   - Animes duplicados entre sources são mesclados (sources[] no objeto)
// ============================================================

import Fastify from "fastify";
import cors    from "@fastify/cors";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath }  from "url";

import {
  initSources,
  listSources,
  getAllSources,
  parseSourceParam,
  parseGenresParam,
  parseMode,
  defaultSource,
} from "./sources/index.js";

import { PORT, API_BASE_URL } from "./common/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Cache simples em memória (TTL 10 min)
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 10 * 60 * 1000) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }
function ckey(...parts) { return parts.join(":"); }

// ── Valida resultado de parse e lança 400 se inválido
function validate(result) {
  if (result.ok === false)
    throw Object.assign(new Error(result.error), { statusCode: 400 });
  return result;
}

// ════════════════════════════════════════════════════════════
// DEDUPLICAÇÃO POR SIMILARIDADE DE TÍTULO
// ════════════════════════════════════════════════════════════

// Normaliza título para comparação: remove sufixos como -hd, -online,
// -dublado, -legendado, números de versão, etc.
function normalizeTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    // Remove sufixos comuns que indicam qualidade/versão mas não mudam o anime
    .replace(/\s*[-–]\s*(hd|fhd|online|hd\d+|online\s*hd|todos\s*os\s*episodios).*$/i, "")
    .replace(/\s+(online|hd|fhd)(\s+hd)?$/i, "")
    // Remove anos entre parênteses ou isolados no final
    .replace(/\s*\(?(19|20)\d{2}\)?$/i, "")
    // Remove sufixos numéricos de versão: -2, -3 (de slugs duplicados do mesmo site)
    // MAS preserva numeração de temporada: "Naruto 2" ≠ "Naruto"
    .replace(/\s*-\d+$/, "")
    // Normaliza espaços
    .replace(/\s+/g, " ")
    .trim();
}

// Similaridade de Jaro-Winkler simplificada (retorna 0.0 – 1.0)
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const maxDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  if (maxDist < 0) return 0;

  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - maxDist);
    const end   = Math.min(i + maxDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }

  if (!matches) return 0;

  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler prefix bonus
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

const SIMILARITY_THRESHOLD = 0.85;

// Deduplica lista de animes vindos de múltiplas sources.
// Animes com similaridade ≥ SIMILARITY_THRESHOLD são mesclados:
// o primeiro encontrado é o "principal" e os outros viram entradas em sources[].
function deduplicateAnimes(animes) {
  const groups = []; // cada grupo = { main, sources: [{sourceId, slug, url}] }

  for (const anime of animes) {
    const normA = normalizeTitle(anime.title || anime.slug);
    let merged = false;

    for (const group of groups) {
      const normB = normalizeTitle(group.main.title || group.main.slug);
      if (similarity(normA, normB) >= SIMILARITY_THRESHOLD) {
        // Mescla: adiciona como source alternativa
        group.sources.push({
          source: anime._source,
          slug:   anime.slug,
          url:    anime.url,
        });
        // Prefere o que tem mais dados (cover, title)
        if (!group.main.cover && anime.cover) group.main.cover = anime.cover;
        merged = true;
        break;
      }
    }

    if (!merged) {
      groups.push({
        main: { ...anime },
        sources: [{ source: anime._source }],
      });
    }
  }

  return groups.map(({ main, sources }) => {
    const { _source, ...rest } = main;
    return {
      ...rest,
      sources, // lista de todas as sources que têm esse anime
    };
  });
}

// Executa uma função em todas as sources em paralelo, ignora erros individuais
async function fetchAllSources(fn) {
  const sources = getAllSources();
  const results = await Promise.allSettled(sources.map((src) => fn(src)));
  const animes  = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      const src  = sources[i];
      const list = results[i].value || [];
      for (const a of list) animes.push({ ...a, _source: src.id });
    } else {
      console.warn(`[multi-source] ${sources[i].id} falhou:`, results[i].reason?.message);
    }
  }
  return animes;
}

// ── Fastify
const app = Fastify({ logger: true });
await app.register(cors, { origin: "*" });

app.setErrorHandler((err, req, reply) => {
  reply.status(err.statusCode || 500).send({ error: err.message || "Erro interno" });
});

// Hook onSend — normaliza URLs. Em modo multi-source não aplica cleanUrls
// (cada source já normaliza os seus próprios dados nos parsers).
app.addHook("onSend", async (req, reply, payload) => {
  const ct = reply.getHeader("content-type") || "";
  if (typeof ct === "string" && ct.includes("text/html")) return payload;
  if (!req._source) return payload; // multi-source: parsers já normalizaram
  try {
    const data = JSON.parse(payload);
    return JSON.stringify(req._source.cleanUrls(data));
  } catch { return payload; }
});

initSources(PORT);

// ============================================================
// ROTAS
// ============================================================

// GET /docs
app.get("/docs", async (req, reply) => {
  try {
    const html = readFileSync(join(__dirname, "static", "docs.html"), "utf8");
    reply.header("content-type", "text/html; charset=utf-8").send(html);
  } catch {
    reply.status(404).send({ error: "docs.html not found" });
  }
});

// GET /img/* — proxy de imagem (sempre precisa de ?source= para saber onde buscar)
app.get("/img/*", async (req, reply) => {
  const { source } = validate(parseSourceParam(req.query.source));
  const { buffer, contentType } = await source.fetchImage(req.params["*"]);
  reply.header("content-type", contentType).send(buffer);
});

// GET /
app.get("/", async () => ({
  name:    "Anify API",
  version: "2.1.0",
  docs:    `${API_BASE_URL}/docs`,
  sources: listSources(),
  routes: {
    "GET /animes":          "Lista paginada — ?page &genres &mode &source (omitir source = todas)",
    "GET /animes/:slug":    "Detalhe do anime — ?source",
    "GET /episodios/:slug": "Episódio + players — ?source",
    "GET /busca?q=":        "Busca em todas as fontes — ?q &genres &mode &source",
    "GET /generos":         "Lista gêneros — ?source (omitir = todas mescladas)",
    "GET /generos/:slug":   "Animes do gênero — ?page &source",
    "GET /recentes":        "Episódios recentes — ?page &source (omitir = todas)",
    "GET /sources":         "Fontes disponíveis",
  },
}));

// GET /sources
app.get("/sources", async () => ({ sources: listSources() }));

// ── GET /animes?page=1&genres=acao&mode=AND&source=
// Sem ?source → consulta todas as fontes e deduplica
app.get("/animes", async (req) => {
  const page = parseInt(req.query.page) || 1;
  const mode = parseMode(req.query.mode);

  let genres = null;
  if (req.query.genres) {
    const p = parseGenresParam(req.query.genres);
    validate(p);
    genres = p.genres;
  }

  // ── Fonte única
  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "animes", page, genres?.join(",") || "", mode);
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, ...hit };
    const result = await source.listAnimes({ page, genres, mode });
    cacheSet(key, result);
    return { cached: false, source: source.id, ...result };
  }

  // ── Multi-source
  const key = ckey("all", "animes", page, genres?.join(",") || "", mode);
  const hit = cacheGet(key);
  if (hit) return { cached: true, sources: "all", ...hit };

  const raw    = await fetchAllSources((src) =>
    src.listAnimes({ page, genres, mode }).then((r) => r.animes)
  );
  const animes = deduplicateAnimes(raw);
  const result = { page, count: animes.length, animes };
  cacheSet(key, result);
  return { cached: false, sources: "all", ...result };
});

// ── GET /animes/:slug?source=
// Com ?source= usa só aquela fonte.
// Sem ?source= tenta todas em paralelo, retorna a primeira com sucesso + altSources.
app.get("/animes/:slug", async (req) => {
  const { slug } = req.params;

  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "anime", slug);
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, ...hit };
    const result = await source.getAnime(slug);
    cacheSet(key, result);
    return { cached: false, source: source.id, ...result };
  }

  const sources = getAllSources();
  const results = await Promise.allSettled(sources.map((src) => src.getAnime(slug)));

  let primary = null, primarySrc = null;
  const alts = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled" && results[i].value) {
      if (!primary) { primary = results[i].value; primarySrc = sources[i].id; }
      else alts.push({ source: sources[i].id, data: results[i].value });
    }
  }

  if (!primary)
    throw Object.assign(new Error(`Anime "${slug}" nao encontrado em nenhuma fonte`), { statusCode: 404 });

  const altSources = alts.map((a) => ({
    source: a.source, slug: a.data.slug, url: a.data.url,
    episodeCount: a.data.episodeCount ?? a.data.episodes?.length ?? null,
  }));

  const result = { ...primary, source: primarySrc, altSources };
  cacheSet(ckey("all", "anime", slug), result);
  return { cached: false, ...result };
});

// ── GET /episodios/:slug?source=
// Com ?source= usa só aquela fonte.
// Sem ?source= tenta todas em paralelo, retorna a primeira com sucesso.
app.get("/episodios/:slug", async (req) => {
  const { slug } = req.params;

  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "ep", slug);
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, ...hit };
    const result = await source.getEpisode(slug);
    cacheSet(key, result);
    return { cached: false, source: source.id, ...result };
  }

  const sources = getAllSources();
  const results = await Promise.allSettled(sources.map((src) => src.getEpisode(slug)));

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled" && results[i].value) {
      const source = sources[i];
      req._source  = source;
      const result = results[i].value;
      cacheSet(ckey(source.id, "ep", slug), result);
      return { cached: false, source: source.id, ...result };
    }
  }

  throw Object.assign(new Error(`Episodio "${slug}" nao encontrado em nenhuma fonte`), { statusCode: 404 });
});

// ── GET /busca?q=naruto&genres=acao&mode=AND&source=
// Sem ?source → busca em todas as fontes e deduplica
app.get("/busca", async (req) => {
  const q = req.query.q;
  if (!q || q.trim().length < 2)
    throw Object.assign(
      new Error("Parâmetro ?q= obrigatório (mínimo 2 chars)"),
      { statusCode: 400 },
    );

  const mode = parseMode(req.query.mode);
  let genres = null;
  if (req.query.genres) {
    const p = parseGenresParam(req.query.genres);
    validate(p);
    genres = p.genres;
  }

  // ── Fonte única
  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "busca", q.toLowerCase(), genres?.join(",") || "", mode);
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, query: q, ...hit };
    const result = await source.search({ q, genres, mode });
    cacheSet(key, result);
    return { cached: false, source: source.id, query: q, ...result };
  }

  // ── Multi-source
  const key = ckey("all", "busca", q.toLowerCase(), genres?.join(",") || "", mode);
  const hit = cacheGet(key);
  if (hit) return { cached: true, sources: "all", query: q, ...hit };

  const raw    = await fetchAllSources((src) =>
    src.search({ q, genres, mode }).then((r) => r.animes || [])
  );
  const animes = deduplicateAnimes(raw);
  const result = { animes };
  cacheSet(key, result);
  return { cached: false, sources: "all", query: q, ...result };
});

// ── GET /generos?source=
// Sem ?source → mescla gêneros de todas as fontes (dedup por slug)
app.get("/generos", async (req) => {
  // ── Fonte única
  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "generos");
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, ...hit };
    const result = await source.listGenres();
    cacheSet(key, result);
    return { cached: false, source: source.id, ...result };
  }

  // ── Multi-source: mescla gêneros por slug (dedup exato)
  const key = ckey("all", "generos");
  const hit = cacheGet(key);
  if (hit) return { cached: true, sources: "all", ...hit };

  const sources = getAllSources();
  const results = await Promise.allSettled(sources.map((s) => s.listGenres()));
  const seen    = new Set();
  const generos = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const g of r.value.generos || []) {
      if (!seen.has(g.slug)) { seen.add(g.slug); generos.push(g); }
    }
  }
  const result = { count: generos.length, generos };
  cacheSet(key, result);
  return { cached: false, sources: "all", ...result };
});

// ── GET /generos/:slug?page=1&source=
// Sem ?source → busca em todas as fontes e deduplica
app.get("/generos/:slug", async (req) => {
  const { slug } = req.params;
  const page = parseInt(req.query.page) || 1;

  // ── Fonte única
  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "genero", slug, page);
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, ...hit };
    const result = await source.getGenreAnimes(slug, { page });
    cacheSet(key, result);
    return { cached: false, source: source.id, ...result };
  }

  // ── Multi-source
  const key = ckey("all", "genero", slug, page);
  const hit = cacheGet(key);
  if (hit) return { cached: true, sources: "all", ...hit };

  const raw    = await fetchAllSources((src) =>
    src.getGenreAnimes(slug, { page }).then((r) => r.animes || [])
  );
  const animes = deduplicateAnimes(raw);
  const result = { genre: slug, page, count: animes.length, animes };
  cacheSet(key, result);
  return { cached: false, sources: "all", ...result };
});

// ── GET /recentes?page=1&source=
// Sem ?source → busca em todas as fontes (sem dedup — episódios têm IDs únicos)
app.get("/recentes", async (req) => {
  const page = parseInt(req.query.page) || 1;

  // ── Fonte única
  if (req.query.source) {
    const { source } = validate(parseSourceParam(req.query.source));
    req._source = source;
    const key = ckey(source.id, "recentes", page);
    const hit = cacheGet(key);
    if (hit) return { cached: true, source: source.id, ...hit };
    const result = await source.listRecent({ page });
    cacheSet(key, result);
    return { cached: false, source: source.id, ...result };
  }

  // ── Multi-source: agrupa por source, sem dedup (ep IDs são diferentes)
  const key = ckey("all", "recentes", page);
  const hit = cacheGet(key);
  if (hit) return { cached: true, sources: "all", ...hit };

  const sources = getAllSources();
  const results = await Promise.allSettled(sources.map((s) => s.listRecent({ page })));
  const bySource = {};
  for (let i = 0; i < sources.length; i++) {
    if (results[i].status === "fulfilled") {
      bySource[sources[i].id] = results[i].value.episodes || [];
    }
  }
  const allEpisodes = Object.values(bySource).flat();
  const result = { page, count: allEpisodes.length, bySource, episodes: allEpisodes };
  cacheSet(key, result);
  return { cached: false, sources: "all", ...result };
});

// ── Start
await app.listen()
//export default app;
console.log(`\n🚀 Anify API v2.1 em ${API_BASE_URL}`);
console.log(`📖 Docs:    ${API_BASE_URL}/docs`);
console.log(`🔌 Fontes:  ${listSources().map((s) => s.id).join(", ")}\n`);