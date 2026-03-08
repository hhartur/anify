// ============================================================
// sources/animesonlinecc/parsers.js
// Todo o scraping/regex específico do animesonlinecc.to
// ============================================================

const BASE = "https://animesonlinecc.to";

// ── Port e source ID injetados pelo index.js via setPort()
let _port     = 3000;
let _sourceId = "animesonlinecc";
let _base     = process.env.API_BASE_URL?.replace(/\/$/, "") || `http://localhost:${_port}`;

export function setParserPort(port, sourceId = "animesonlinecc") {
  _port     = port;
  _sourceId = sourceId;
  _base     = process.env.API_BASE_URL?.replace(/\/$/, "") || `http://localhost:${_port}`;
}

// ── Normaliza URLs do site para apontar para esta API
const ROUTE_MAP = { episodio: "episodios", anime: "animes", genero: "generos" };

function normalizePath(url) {
  if (typeof url !== "string" || !url.startsWith(BASE)) return url;
  let p = url.replace(BASE, "");
  if (
    p.startsWith("/wp-content") ||
    p.startsWith("/img") ||
    /\.(jpg|jpeg|png|webp|gif)$/i.test(p)
  ) {
    return `${_base}/img${p}?source=${_sourceId}`;
  }
  const parts = p.split("/").filter(Boolean);
  if (parts.length > 0 && ROUTE_MAP[parts[0]]) parts[0] = ROUTE_MAP[parts[0]];
  return `${_base}/${parts.join("/")}`;
}

// Normaliza qualquer string que seja URL do site
function n(url) { return normalizePath(url); }

// ── Extrai lista de animes de uma página de listagem
export function parseAnimeList(html) {
  const seen = new Set();
  const animes = [];

  const blockRe =
    /<a[^>]+href="(https?:\/\/animesonlinecc\.to\/anime\/([^/"]+)\/?)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;

  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const rawUrl = m[1].replace(/\/$/, "") + "/";
    const slug   = m[2];
    const inner  = m[3];

    if (seen.has(slug) || slug === "page" || slug === "feed") continue;
    seen.add(slug);

    // Capa
    let cover = null;
    const imgM = inner.match(
      /(?:data-src|data-lazy-src|src)="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/i,
    );
    if (imgM) cover = n(imgM[1]);

    // Título
    let title = null;
    const h3M  = inner.match(/<h[23][^>]*>\s*([^<]{2,80}?)\s*<\/h[23]>/i);
    const altM = inner.match(/\balt="([^"]{2,80})"/i);
    const titM = inner.match(/\btitle="([^"]{2,80})"/i);
    if (h3M)       title = h3M[1].trim();
    else if (altM) title = altM[1].trim();
    else if (titM) title = titM[1].trim();

    if (title) {
      title = title
        .replace(/\s*[-–]\s*Animes?\s*Online.*$/i, "")
        .replace(/\s+Todos os Episodios Online.*$/i, "")
        .trim();
    }



    animes.push({
      slug,
      url: n(rawUrl),
      ...(title && { title }),
      ...(cover && { cover }),
    });
  }

  // Fallback
  if (animes.length === 0) {
    const re = /href="(https?:\/\/animesonlinecc\.to\/anime\/([^/"]+)\/?)"/gi;
    let fm;
    while ((fm = re.exec(html)) !== null) {
      const rawUrl = fm[1].replace(/\/$/, "") + "/";
      const slug   = fm[2];
      if (seen.has(slug) || slug === "page" || slug === "feed") continue;
      seen.add(slug);
      animes.push({ slug, url: n(rawUrl) });
    }
  }

  return animes;
}

// ── Extrai total de páginas de listagens
export function parseTotalPages(html, pattern) {
  const ms = [...html.matchAll(pattern)];
  return ms.length ? Math.max(...ms.map((m) => parseInt(m[1]))) : 1;
}

// ── Página de detalhe de um anime
export function parseAnimePage(html, slug) {
  const log = (...a) => console.log(`[animesonlinecc:anime:${slug}]`, ...a);

  const rawTitle =
    html.match(/og:title"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([^<]+)/i)?.[1]?.replace(/ - Animes Online$/, "").trim() ||
    slug;

  const rawImage = html.match(/og:image"[^>]+content="([^"]+)"/i)?.[1] || null;

  const descMatch = html.match(/<div class="wp-content">\s*<p>([\s\S]*?)<\/p>/i);
  const description = descMatch
    ? descMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    : null;

  // Ano
  let year = null;
  const dateM = html.match(/"datePublished"\s*:\s*"(\d{4})/i);
  if (dateM) year = parseInt(dateM[1]);
  if (!year) {
    const spanM = html.match(/<span[^>]*>\s*(20\d{2}|19\d{2})\s*<\/span>/);
    if (spanM) year = parseInt(spanM[1]);
  }

  // Gêneros
  const genres = [];
  const seenG  = new Set();
  const genreRe =
    /<a[^>]+href="https?:\/\/animesonlinecc\.to\/genero\/([^/"]+)\/?"[^>]*>([^<]+)<\/a>/gi;
  let gm;
  while ((gm = genreRe.exec(html)) !== null) {
    const gs = gm[1].trim();
    if (gs.startsWith("letra-") || seenG.has(gs)) continue;
    seenG.add(gs);
    genres.push({
      slug: gs,
      name: gm[2].trim(),
      url: n(`${BASE}/genero/${gs}/`),
    });
  }

  // Temporadas
  const seasons = [];
  let totalEpisodes = 0;
  const seBlocks = html.split(/<div[^>]*class="[^"]*se-c[^"]*"[^>]*>/i).slice(1);
  let seasonIndex = 0;

  for (const block of seBlocks) {
    seasonIndex++;
    let seasonName =
      block.match(/<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/span>/i)?.[1]?.trim() ||
      (() => {
        const t = block.match(/<span[^>]*class="[^"]*se-t[^"]*"[^>]*>(\d+)<\/span>/i);
        return t ? `Temporada ${t[1]}` : null;
      })() ||
      `Temporada ${seasonIndex}`;

    const ulM = block.match(/<ul[^>]*class="[^"]*episodios[^"]*"[^>]*>([\s\S]*?)<\/ul>/i);
    if (!ulM) continue;

    const epRe =
      /href="(https?:\/\/animesonlinecc\.to\/episodio\/([^/"]+)-episodio-(\d+)\/?)"[^>]*>/gi;
    const episodes = [];
    const epSeen = new Set();
    let em;
    while ((em = epRe.exec(ulM[1])) !== null) {
      const epSlug = em[2] + "-episodio-" + em[3];
      if (epSeen.has(epSlug)) continue;
      epSeen.add(epSlug);
      const rawEpUrl = em[1].replace(/\/$/, "") + "/";
      // Tenta extrair thumbnail do bloco <li> (±400 chars ao redor do match)
      const around = ulM[1].substring(Math.max(0, em.index - 400), em.index + 400);
      const imgM   = around.match(/<img[^>]+(?:src|data-src)="([^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/i);
      episodes.push({
        slug: epSlug,
        animeSlug: em[2],
        number: parseInt(em[3]),
        image: imgM ? n(imgM[1]) : null,
        url: n(rawEpUrl),
      });
    }
    episodes.sort((a, b) => a.number - b.number);
    totalEpisodes += episodes.length;
    seasons.push({
      index: seasonIndex,
      name: seasonName,
      animeSlug: episodes[0]?.animeSlug ?? null,
      episodeCount: episodes.length,
      episodes,
    });
  }

  // Fallback sem div.se-c
  if (seasons.length === 0) {
    const epRe =
      /href="(https?:\/\/animesonlinecc\.to\/episodio\/([^/"]+)-episodio-(\d+)\/?)">/gi;
    const episodes = [];
    const epSeen = new Set();
    let em;
    while ((em = epRe.exec(html)) !== null) {
      const epSlug = em[2] + "-episodio-" + em[3];
      if (epSeen.has(epSlug)) continue;
      epSeen.add(epSlug);
      const rawEpUrl = em[1].replace(/\/$/, "") + "/";
      const around = html.substring(Math.max(0, em.index - 400), em.index + 400);
      const imgM   = around.match(/<img[^>]+(?:src|data-src)="([^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/i);
      episodes.push({
        slug: epSlug,
        animeSlug: em[2],
        number: parseInt(em[3]),
        image: imgM ? n(imgM[1]) : null,
        url: n(rawEpUrl),
      });
    }
    episodes.sort((a, b) => a.number - b.number);
    totalEpisodes = episodes.length;
    seasons.push({
      index: 1,
      name: "Temporada 1",
      animeSlug: episodes[0]?.animeSlug ?? null,
      episodeCount: episodes.length,
      episodes,
    });
  }

  log(`✅ ${totalEpisodes} ep(s) em ${seasons.length} temporada(s)`);

  return {
    slug,
    title: rawTitle.replace(/\s+Todos os Episodios Online$/, "").trim(),
    image: n(rawImage),
    description,
    year,
    genres: [...new Map(genres.map((g) => [g.slug, g])).values()],
    seasonCount: seasons.length,
    episodeCount: totalEpisodes,
    seasons,
    url: n(`${BASE}/anime/${slug}/`),
  };
}

// ── Página de episódio
export function parseEpisodePage(html, slug) {
  const rawTitle =
    html.match(/og:title"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<title>([^<]+)/i)?.[1]?.replace(/ - Animes Online$/, "").trim() ||
    slug;

  const rawImage    = html.match(/og:image"[^>]+content="([^"]+)"/i)?.[1] || null;
  const numM        = rawTitle.match(/Episodio\s+(\d+)/i);
  const epNumber    = numM ? parseInt(numM[1]) : null;
  const animeName   = rawTitle.replace(/\s*Episodio\s+\d+.*$/i, "").trim();
  const slugM       = slug.match(/^(.+)-episodio-\d+$/);
  const animeSlug   = slugM ? slugM[1] : null;
  const rawAnimeUrl = animeSlug ? `${BASE}/anime/${animeSlug}/` : null;

  const iframeRe = /iframe[^>]+src="([^"]+)"/gi;
  const players  = [];
  let im;
  while ((im = iframeRe.exec(html)) !== null) {
    const src = im[1].replace(/&amp;/g, "&");
    let type = "unknown";
    if (src.includes("blogger.com/video")) type = "blogger";
    else if (src.includes("youtube.com"))  type = "youtube";
    else if (src.includes("drive.google")) type = "gdrive";
    else if (src.includes("ok.ru"))        type = "ok";
    else if (src.includes("dailymotion"))  type = "dailymotion";
    else if (src.includes("mp4upload"))    type = "mp4upload";
    // Players externos NÃO são normalizados — são embeds de terceiros
    players.push({ type, src });
  }

  const optRe =
    /<a class="options"[^>]+href="#option-(\d+)"[^>]*>\s*(?:<[^>]+>\s*)?([^<\s]+)/gi;
  const options = [];
  let om;
  while ((om = optRe.exec(html)) !== null) {
    options.push({ id: om[1], label: om[2].trim() });
  }

  const prevM = html.match(
    /href="(https?:\/\/animesonlinecc\.to\/episodio\/[^"]+)"[^>]*>\s*<i[^>]+icon-chevron-left/i,
  );
  const nextM =
    html.match(
      /icon-chevron-right[^<]*<\/i>\s*<span[^>]*>[^<]*<\/span>\s*<\/a>.*?href="(https?:\/\/animesonlinecc\.to\/episodio\/[^"]+)"/is,
    ) ||
    html.match(
      /href="(https?:\/\/animesonlinecc\.to\/episodio\/[^"]+)"[^>]*>\s*<span[^>]*>Proximo\s+episodio/i,
    );

  return {
    slug,
    title: rawTitle,
    animeName,
    animeSlug,
    animeUrl: n(rawAnimeUrl),
    epNumber,
    image: n(rawImage),
    players,
    playerOptions: options,
    prev: prevM ? n(prevM[1]) : null,
    next: nextM ? n(nextM[1]) : null,
    url: n(`${BASE}/episodio/${slug}/`),
  };
}