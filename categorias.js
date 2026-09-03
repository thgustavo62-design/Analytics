// Vocabulário canônico de categoria + mapeamento dos rótulos que chegam de fora
// (grupo do ERP, coleta de concorrente, classificador por palavra-chave).
//
//   categoriaCanonica(rotulo)  -> um dos config/categorias-sinonimos.json.canonicos, ou o
//                                 próprio rótulo em title-case se não houver alias
//   mapGrupoErp(grupo)         -> { categoria, subcategoria?, classe_comercial? } | null
//   expandirSuperGrupo(rotulo) -> [canonicos...] (ex.: "Bebê" -> ["Bebê","Fraldas","Leite Infantil"])
//
// Configs recarregados a cada chamada (edição sem reiniciar).

const fs = require("fs");
const path = require("path");

const SIN_PATH = path.join(__dirname, "config", "categorias-sinonimos.json");
const GRP_PATH = path.join(__dirname, "config", "grupos-erp.json");

let _sin = null, _sinMtime = 0, _grp = null, _grpMtime = 0;
function loadSin() {
  try {
    const m = fs.statSync(SIN_PATH).mtimeMs;
    if (!_sin || m !== _sinMtime) { _sin = JSON.parse(fs.readFileSync(SIN_PATH, "utf8")); _sinMtime = m; }
  } catch { _sin = _sin || { canonicos: [], aliases: {}, super_grupos: {} }; }
  return _sin;
}
function loadGrp() {
  try {
    const m = fs.statSync(GRP_PATH).mtimeMs;
    if (!_grp || m !== _grpMtime) { _grp = JSON.parse(fs.readFileSync(GRP_PATH, "utf8")); _grpMtime = m; }
  } catch { _grp = _grp || { por_prefixo: [] }; }
  return _grp;
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const titulo = (s) => String(s || "").trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function categoriaCanonica(rotulo) {
  if (rotulo == null || rotulo === "") return null;
  const cfg = loadSin();
  const k = norm(rotulo);
  if (cfg.aliases && cfg.aliases[k]) return cfg.aliases[k];
  // canônico já bate (ignorando caixa/acento)?
  const hit = (cfg.canonicos || []).find((c) => norm(c) === k);
  if (hit) return hit;
  // "GRUPO - SUBGRUPO" -> tenta só o grupo
  if (k.includes(" - ")) {
    const g = k.split(" - ")[0].trim();
    if (cfg.aliases && cfg.aliases[g]) return cfg.aliases[g];
  }
  return titulo(rotulo);
}

function mapGrupoErp(grupo) {
  if (!grupo) return null;
  const k = norm(grupo);
  const prefixo = k.includes(" - ") ? k.split(" - ")[0].trim() : k; // formato "GRUPO - SUBGRUPO"
  const cfg = loadGrp();
  const regras = cfg.por_prefixo || [];
  // 1) regras marcadas "prefixo": casam com o PREFIXO do grupo (formato "GRUPO - SUBGRUPO").
  //    Necessário para GENERICO/SIMILAR/ETICO/OTC — o nome do grupo OTC contém "eticos".
  let melhor = null;
  for (const r of regras) {
    if (!r.prefixo) continue;
    const m = norm(r.match);
    if (m === prefixo || prefixo.startsWith(m) || m.startsWith(prefixo)) { melhor = { ...r }; break; }
  }
  // 2) senão, a regra (não-prefixo) cujo match é substring do grupo, mais longa vence
  if (!melhor) {
    let len = -1;
    for (const r of regras) {
      if (r.prefixo) continue;
      const m = norm(r.match);
      if (k.includes(m) && m.length > len) { melhor = { ...r }; len = m.length; }
    }
  }
  if (!melhor) return null;
  return {
    categoria: categoriaCanonica(melhor.categoria) || melhor.categoria,
    subcategoria: melhor.subcategoria || null,
    classe_comercial: melhor.classe_comercial || null,
  };
}

// "Bebê" -> ["Bebê","Fraldas","Leite Infantil"] ; qualquer outro -> [canônico dele]
function expandirSuperGrupo(rotulo) {
  const cfg = loadSin();
  const canon = categoriaCanonica(rotulo);
  const sg = cfg.super_grupos || {};
  if (sg[canon]) return [...new Set([canon, ...sg[canon]])];
  // rótulo cru que é chave de super_grupo (ex.: concorrente manda "Bebê")
  for (const [nome, membros] of Object.entries(sg)) {
    if (norm(nome) === norm(rotulo) || norm(nome) === norm(canon)) return [...new Set([nome, ...membros])];
  }
  return [canon];
}

module.exports = { categoriaCanonica, mapGrupoErp, expandirSuperGrupo, CANONICOS: () => loadSin().canonicos || [] };
