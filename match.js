// Casamento de nome de produto por sobreposição de tokens.
// Portado de app_minasfarma/match.js (função pura, sem I/O), generalizado para casar um
// texto livre (nome de oferta de concorrente) contra uma lista de produtos nossos.

const STOPWORDS = new Set([
  "DE", "DA", "DO", "DAS", "DOS", "COM", "PARA", "E", "O", "A", "UN", "UND",
  "ML", "G", "KG", "L", "GR", "MG", "UNIDADE", "UNIDADES", "C", "CX", "P", "S",
]);

function normalize(s) {
  if (s == null) return "";
  return String(s)
    .toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return normalize(s).split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Score = Jaccard dos tokens, com bônus se todos os tokens da "marca" (primeira palavra
// significativa do texto de busca) aparecem no candidato.
function scorePair(queryTokens, brandTokens, candTokenSet) {
  if (queryTokens.size === 0 || candTokenSet.size === 0) return { score: 0, overlap: 0 };
  let overlap = 0;
  for (const t of queryTokens) if (candTokenSet.has(t)) overlap++;
  if (overlap === 0) return { score: 0, overlap: 0 };
  const unionSize = new Set([...queryTokens, ...candTokenSet]).size;
  let score = overlap / unionSize;
  if (brandTokens.length && brandTokens.every((t) => candTokenSet.has(t))) score += 0.15;
  return { score: Math.min(score, 1), overlap };
}

// candidates: [{ name, ...qualquer coisa }]. Devolve o melhor candidato + score, ou null.
// minScore/minOverlap evitam falso-positivo em palavra genérica ("CREME" sozinho).
// opts.brand: se informado (ex.: coluna "Marca" da planilha de concorrentes), vira filtro
// DURO — o candidato só entra se contiver todos os tokens da marca. Mata casamento errado
// tipo "Loção Nivea" -> "FLETOP LOCAO" ou "Colgate Tripla Ação" -> "COREGA ... TRIPLA ACAO".
function bestMatch(text, candidates, opts = {}) {
  const minScore = opts.minScore ?? 0.4;
  const minOverlap = opts.minOverlap ?? 2;
  const queryTokens = new Set(tokens(text));
  const brandHard = opts.brand != null && String(opts.brand).trim() !== "";
  const brandTokens = brandHard ? tokens(opts.brand) : tokens(text).slice(0, 1);

  let best = null;
  let bestScore = 0;
  let bestOverlap = 0;
  for (const c of candidates) {
    const set = c._tokens || (c._tokens = new Set(tokens(c.name)));
    if (brandHard && brandTokens.length && !brandTokens.every((t) => set.has(t))) continue;
    const { score, overlap } = scorePair(queryTokens, brandTokens, set);
    if (score > bestScore) {
      bestScore = score;
      best = c;
      bestOverlap = overlap;
    }
  }
  if (best && bestScore >= minScore && bestOverlap >= minOverlap) {
    return { match: best, score: Math.round(bestScore * 100) / 100, overlap: bestOverlap };
  }
  return null;
}

module.exports = { normalize, tokens, bestMatch };
