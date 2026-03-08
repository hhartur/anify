// ============================================================
// sources/goyabu/parsers.js
// Scraping específico do goyabu.io
//
// Estrutura do site:
//   - Lista de animes: /lista-de-animes?l=todos (HTML) ou REST API
//   - Detalhe do anime: /anime/<slug> — episódios embutidos como
//     `const allEpisodes = [...]` em JS inline
//   - Episódio: /<id-numerico> (ex: /55106)
//   - Players: `var playersData = [...]` em JS inline
//   - Gêneros: /generos e /generos/<slug>
//   - Busca: /?s=termo ou REST wp-json/animeonline/search/?s=
//   - Recentes: / (home) e /lancamentos e /page/N
// ============================================================

const BASE = "https://goyabu.io";

let _port     = 3000;
let _sourceId = "goyabu";
let _base     = process.env.API_BASE_URL?.replace(/\/$/, "") || `http://localhost:${_port}`;

export function setParserPort(port, sourceId = "goyabu") {
  _port     = port;
  _sourceId = sourceId;
  _base     = process.env.API_BASE_URL?.replace(/\/$/, "") || `http://localhost:${_port}`;
}

// ── Normaliza URLs do site para a API local
function normalizePath(url) {
  if (typeof url !== "string" || !url) return url;
  // Imagens do wp-content ou miniatures — proxy local
  if (url.startsWith("/wp-content") || url.startsWith("/miniatures")) {
    return `${_base}/img${url}?source=${_sourceId}`;
  }
  if (url.startsWith(BASE + "/wp-content") || url.startsWith(BASE + "/miniatures")) {
    return `${_base}/img${url.replace(BASE, "")}`;
  }
  // API de imagens externas (api.myblogapi.site) — proxy via /img/external/
  if (url.includes("myblogapi.site/storage")) {
    const path = url.replace("https://api.myblogapi.site", "");
    return `${_base}/img/external${path}?source=${_sourceId}`;
  }
  // URLs do site → rota local
  if (url.startsWith(BASE)) {
    const p = url.replace(BASE, "");
    return normalizeLocalPath(p);
  }
  // Paths relativos
  if (url.startsWith("/")) {
    return normalizeLocalPath(url);
  }
  return url;
}

function normalizeLocalPath(p) {
  // /anime/<slug> → /animes/<slug>
  if (p.startsWith("/anime/")) return `${_base}/animes/${p.replace("/anime/", "")}`;
  // /<id-numerico> → /episodios/<id>
  if (/^\/\d+\/?$/.test(p)) return `${_base}/episodios/${p.replace(/\//g, "")}`;
  // /generos/<slug> → /generos/<slug>
  if (p.startsWith("/generos/")) return `${_base}${p}`;
  return `${_base}${p}`;
}

export function n(url) { return normalizePath(url); }

// ── Extrai allEpisodes do JS inline da página do anime
export function parseAllEpisodes(html) {
  const m = html.match(/const allEpisodes\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[1]);
    return raw.map((ep) => ({
      id:     ep.id,
      number: parseInt(ep.episodio) || 0,
      image:  ep.imagem ? n(ep.imagem) : (ep.miniature ? n(ep.miniature) : null),
      url:    `${_base}/episodios/${ep.id}`,
    }));
  } catch {
    return [];
  }
}

// ── Extrai dados do anime via JSON-LD (schema.org) embutido no <head>
export function parseJsonLd(html) {
  const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return {};
  try {
    const graph = JSON.parse(m[1])["@graph"] || [];
    const page  = graph.find((g) => g["@type"] === "WebPage") || {};
    return {
      url:          page.url || null,
      title:        page.name || null,
      description:  page.description || null,
      image:        page.thumbnailUrl || page.image?.url || null,
      datePublished: page.datePublished || null,
    };
  } catch {
    return {};
  }
}

// ── Página de detalhe do anime
export function parseAnimePage(html, slug) {
  const log = (...a) => console.log(`[goyabu:anime:${slug}]`, ...a);

  const ld = parseJsonLd(html);

  // OG tags como fallback
  const title =
    ld.title ||
    html.match(/og:title"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([^<]+)/i)?.[1]?.replace(/ - Goyabu$/, "").trim() ||
    slug;

  const image = n(
    ld.image ||
    html.match(/og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    null
  );

  // Descrição — span.sinopse-full ou sinopse-short
  const descFull  = html.match(/<span class="sinopse-full"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const descShort = html.match(/<span class="sinopse-short"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const description = (descFull || descShort || ld.description || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim() || null;

  // Gêneros — href="/generos/slug">Nome
  const genres = [];
  const seenG  = new Set();
  const genreRe = /href="https?:\/\/goyabu\.io\/generos\/([^/"]+)"[^>]*>\s*([^<]+)/gi;
  let gm;
  while ((gm = genreRe.exec(html)) !== null) {
    const gs = gm[1].trim();
    if (seenG.has(gs)) continue;
    seenG.add(gs);
    genres.push({
      slug: gs,
      name: gm[2].trim(),
      url:  `${_base}/generos/${gs}`,
    });
  }

  // Episódios embutidos no JS
  const episodes = parseAllEpisodes(html);
  log(`✅ ${episodes.length} episódio(s)`);

  return {
    slug,
    title: title.replace(/ - (Todos os Episódios|Online|Goyabu).*$/i, "").trim(),
    image,
    description,
    genres,
    episodeCount: episodes.length,
    episodes,
    url: n(`${BASE}/anime/${slug}`),
  };
}

// ── Página do episódio
export function parseEpisodePage(html, id) {
  const log = (...a) => console.log(`[goyabu:ep:${id}]`, ...a);

  const ld = parseJsonLd(html);

  // Título e número
  const rawTitle =
    ld.title ||
    html.match(/og:title"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([^<]+)/i)?.[1]?.replace(/ - Goyabu$/, "").trim() ||
    String(id);

  const image = n(
    ld.image ||
    html.match(/og:image"[^>]+content="([^"]+)"/i)?.[1] ||
    null
  );

  // "One Punch Man 3 Episódio 1" → number=1, animeName="One Punch Man 3"
  const numM     = rawTitle.match(/Epis[oó]d[io]+\s*(\d+)/i);
  const epNumber = numM ? parseInt(numM[1]) : null;
  const animeName = rawTitle.replace(/\s*[-–]\s*Epis[oó]d[io]+.*$/i, "").replace(/ - Goyabu$/, "").trim();

  // Slug do anime — via breadcrumb link ou href no HTML
  const animeHrefM = html.match(/href="(https?:\/\/goyabu\.io\/anime\/([^/"]+))"/i);
  const animeSlug  = animeHrefM ? animeHrefM[2] : null;
  const animeUrl   = animeSlug ? `${_base}/animes/${animeSlug}` : null;

  // playersData = [...] embutido no JS inline
  const players = [];
  const pdM = html.match(/var playersData\s*=\s*(\[[\s\S]*?\]);/);
  if (pdM) {
    try {
      const raw = JSON.parse(pdM[1]);
      for (const p of raw) {
        let type = "unknown";
        if (p.select === "blogger" || (p.url || "").includes("blogger.com")) type = "blogger";
        else if ((p.url || "").includes("youtube.com"))  type = "youtube";
        else if ((p.url || "").includes("drive.google")) type = "gdrive";
        else if ((p.url || "").includes("ok.ru"))        type = "ok";
        else if ((p.url || "").includes("dailymotion"))  type = "dailymotion";
        else if ((p.url || "").includes("mp4upload"))    type = "mp4upload";
        else if (p.select)                               type = p.select;
        players.push({
          type,
          name:   p.name || null,
          audio:  p.idioma || null,   // "" = legendado, "dub" = dublado
          url:    p.url || null,
          token:  p.blogger_token || null,
        });
      }
    } catch {}
  }
  log(`✅ ${players.length} player(s)`);

  // Prev/next — calculado via allEpisodes na página do anime
  const postIds = [...html.matchAll(/data-post-id="(\d+)"/g)].map((m) => parseInt(m[1]));
  const prevId  = postIds.find((pid) => pid !== parseInt(id)) || null;

  // Áudio do episódio (se disponível)
  const audioM = html.match(/class="[^"]*audio[^"]*"[^>]*>\s*([^<]+)/i);
  const audio  = audioM ? audioM[1].trim() : null;

  return {
    id:       parseInt(id),
    title:    rawTitle.replace(/ - Goyabu$/, "").trim(),
    animeName,
    animeSlug,
    animeUrl,
    epNumber,
    audio,
    image,
    players,
    url: `${_base}/episodios/${id}`,
  };
}

// ── Lista de animes de uma página HTML (home, lista, gênero, busca)
export function parseAnimeList(html) {
  const seen   = new Set();
  const animes = [];

  // Padrão principal: href="/anime/<slug>" com bloco interno
  const blockRe = /href="https?:\/\/goyabu\.io\/anime\/([^/"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const slug  = m[1];
    const inner = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);

    // Capa
    let cover = null;
    const imgM = inner.match(/(?:data-src|data-lazy-src|src)="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/i);
    if (imgM) cover = n(imgM[1]);

    // Título — alt, h3/h2 ou title
    let title = null;
    const h3M  = inner.match(/<h[23][^>]*>\s*([^<]{2,80}?)\s*<\/h[23]>/i);
    const altM = inner.match(/\balt="([^"]{2,80})"/i);
    const titM = inner.match(/\btitle="([^"]{2,80})"/i);
    if (h3M)       title = h3M[1].trim();
    else if (altM) title = altM[1].trim();
    else if (titM) title = titM[1].trim();
    if (title) title = title.replace(/ - Goyabu$/i, "").trim();

    animes.push({
      slug,
      url: `${_base}/animes/${slug}`,
      ...(title && { title }),
      ...(cover && { cover }),
    });
  }

  return animes;
}

// ── Extrai total de páginas
export function parseTotalPages(html, pattern) {
  const ms = [...html.matchAll(pattern)];
  return ms.length ? Math.max(...ms.map((m) => parseInt(m[1]))) : 1;
}

// ── Extrai gêneros da página /generos
export function parseGenreList(html) {
  const seen   = new Set();
  const genres = [];
  const re = /href="https?:\/\/goyabu\.io\/generos\/([^/"]+)"[^>]*>\s*([^<]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1].trim();
    if (seen.has(slug)) continue;
    seen.add(slug);
    genres.push({
      slug,
      name: m[2].trim(),
      url:  `${_base}/generos/${slug}`,
    });
  }
  return genres;
}

// ── Extrai episódios recentes da home / /lancamentos / /page/N
export function parseRecentEpisodes(html) {
  const seen = new Set();
  const episodes = [];
  const re = /href="https?:\/\/goyabu\.io\/(\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id    = m[1];
    const inner = m[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const titleM = inner.match(/<b[^>]*class="[^"]*title-post[^"]*"[^>]*>\s*([^<]+)/i);
    const epM    = inner.match(/<b[^>]*class="[^"]*type-episodio[^"]*"[^>]*>\s*([^<]+)/i);
    const numM   = (epM?.[1] || "").match(/\d+/);
    const imgM   = inner.match(/(?:data-src|data-lazy-src|src)="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/i);

    episodes.push({
      id:        parseInt(id),
      animeName: titleM?.[1]?.trim() || null,
      epNumber:  numM ? parseInt(numM[0]) : null,
      cover:     imgM ? n(imgM[1]) : null,
      url:       `${_base}/episodios/${id}`,
    });
  }
  return episodes;
}