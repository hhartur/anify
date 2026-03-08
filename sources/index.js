// ============================================================
// sources/index.js  — Registry de fontes
//
// Para adicionar uma nova fonte:
//   1. Crie sources/<id>/index.js implementando a interface padrão
//   2. Importe e registre no array SOURCES abaixo
//   3. Pronto — todas as rotas automaticamente incluem a nova fonte
//
// Interface obrigatória:
//   source.id, source.name
//   source.listAnimes({ page, genres, mode })
//   source.getAnime(slug)
//   source.getEpisode(slug)          ← goyabu recebe ID numérico
//   source.search({ q, genres, mode })
//   source.listGenres()
//   source.listRecent({ page })
//   source.getGenreAnimes(slug, { page })
//   source.fetchImage(path)
//   source.setPort(port)
//   source.cleanUrls(obj)
// ============================================================

import animesonlinecc from "./animesonlinecc/index.js";
import goyabu         from "./goyabu/index.js";

// ── Registre novas fontes aqui
const SOURCES = [
  animesonlinecc,
  goyabu,
];

// Mapa rápido id → fonte
const SOURCE_MAP = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

// ── Retorna fonte pelo id, lança 400 se inválido
export function getSource(id) {
  const src = SOURCE_MAP[id];
  if (!src)
    throw Object.assign(
      new Error(`Fonte desconhecida: "${id}". Disponíveis: ${SOURCES.map((s) => s.id).join(", ")}`),
      { statusCode: 400 },
    );
  return src;
}

// ── Fonte padrão (a primeira da lista)
export function defaultSource() {
  return SOURCES[0];
}

// ── Lista todas as fontes registradas (resumo)
export function listSources() {
  return SOURCES.map((s) => ({ id: s.id, name: s.name }));
}

// ── Retorna todos os objetos de fonte (usado pelo multi-source no api.js)
export function getAllSources() {
  return SOURCES;
}

// ── Inicia todas as fontes com a porta da API
export function initSources(port) {
  for (const s of SOURCES) s.setPort(port);
}

// ════════════════════════════════════════════════════════════
// Helpers de validação de parâmetros (usados pelo api.js)
// ════════════════════════════════════════════════════════════

// Valida e normaliza ?genres=acao,aventura
export function parseGenresParam(raw) {
  if (!raw || raw.trim().length === 0)
    return { ok: false, error: "Parâmetro ?genres= ausente" };

  const rawParts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (rawParts.length === 0)
    return { ok: false, error: "Nenhum gênero válido após split" };
  if (rawParts.length > 5)
    return { ok: false, error: `Máximo 5 gêneros (recebeu ${rawParts.length})` };

  const bad = rawParts.filter((g) => !/^[a-z0-9-]+$/.test(g));
  if (bad.length)
    return {
      ok: false,
      error: `Slug(s) inválido(s): ${bad.join(", ")} — use apenas letras minúsculas, números e hífens`,
    };

  return { ok: true, genres: rawParts.map((s) => s.toLowerCase()) };
}

// Normaliza ?mode=AND|OR → "AND" | "OR"  (default AND)
export function parseMode(raw) {
  return (raw || "AND").toUpperCase() === "OR" ? "OR" : "AND";
}

// Valida ?source=id (opcional — usa default se ausente)
export function parseSourceParam(raw) {
  if (!raw) return { ok: true, source: defaultSource() };
  try {
    return { ok: true, source: getSource(raw) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}