// Fase A — papel de marketing por produto.
//
// Camada DETERMINÍSTICA. Recebe um produto já analisado por marketing-product-analytics
// (com percentis, tendência, cobertura, margem, opportunity) e atribui:
//   - papel_primario  : o papel de campanha mais forte do produto
//   - papeis          : todos os papéis que o produto serve (primário primeiro)
//   - detalhe[]       : por papel — força 0..1, racional textual e confiança
//   - confianca       : confiança do papel primário
//
// A IA não escolhe papel. Limiares em config/marketing-roles.json.

const fs = require("fs");
const path = require("path");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketing-roles.json"), "utf8"));
const CFG_STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketing-stock.json"), "utf8"));
const L = CFG.limiares;
const RECORR = new Set(CFG.categorias_recorrencia.map((s) => s.toLowerCase()));
const IMG = new Set(CFG.categorias_imagem.map((s) => s.toLowerCase()));
const PISO_MARGEM = CFG_STOCK.margem_pct_minima_para_anunciar != null ? CFG_STOCK.margem_pct_minima_para_anunciar : 0.1;

function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function pctTxt(v) { return v == null ? "s/ base" : (v > 0 ? "+" : "") + v + "%"; }

// avalia cada papel candidato -> { forca, rationale, confianca } ou null se não serve
function avaliar(p) {
  const perc = p.percentis || {};
  const pRec = perc.receita == null ? 0 : perc.receita;
  const pCup = perc.cupons == null ? 0 : perc.cupons;
  const preco = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
  const precoProxy = p.preco_atual == null;
  const cob = p.cobertura_rotulo;
  const cobPromovivel = cob == null || cob === "SEM_ESTOQUE" || ["NORMAL", "OPORTUNIDADE", "ATENCAO"].includes(cob);
  const excesso = cob === "PARADO" || p.cobertura_infinita || (p.dias_cobertura != null && p.dias_cobertura >= L.desova_cobertura_dias);
  const margemOk = p.margem_pct == null || p.margem_pct >= PISO_MARGEM;
  const cupons30 = (p.cupons && p.cupons.d30) || 0;
  const un30 = (p.unidades && p.unidades[30]) || 0;
  const tend = p.tendencia && p.tendencia.pct;
  const cat = String(p.categoria || "").toLowerCase();
  const out = {};

  // HERO — produto principal: alto faturamento e estoque comporta anúncio.
  // forca teto 0.97 para que um item genuinamente PARADO (DESOVA=1.0) assuma o papel primário.
  if (pRec >= L.hero_percentil_receita && cob !== "RUPTURA") {
    out.HERO = { forca: Math.min(0.97, pRec), confianca: 0.9, rationale: `receita no percentil ${Math.round(pRec * 100)} da loja; cobertura ${cob || "s/ feed"}` };
  }
  // TRAFEGO — grande procura: muitos cupons distintos
  if (pCup >= L.trafego_percentil_cupons && cob !== "RUPTURA") {
    out.TRAFEGO = { forca: pCup, confianca: 0.9, rationale: `presença em cupom no percentil ${Math.round(pCup * 100)} (${cupons30} cupons/30d)` };
  }
  // CHAMARIZ — preço agressivo puxa fluxo: procura boa + preço baixo + dá pra cobrir e margem não é negativa
  if (pCup >= L.chamariz_percentil_cupons && preco != null && preco <= L.chamariz_preco_max && cobPromovivel && margemOk) {
    const forca = clamp01(0.55 * pCup + 0.45 * (1 - preco / L.chamariz_preco_max));
    out.CHAMARIZ = { forca, confianca: precoProxy ? 0.7 : 0.9, rationale: `preço R$ ${preco.toFixed(2)}${precoProxy ? " (médio praticado)" : ""} + procura no percentil ${Math.round(pCup * 100)}; puxa fluxo` };
  }
  // MARGEM — recupera rentabilidade: margem forte, algum volume, sem risco de ruptura
  if (p.margem_pct != null && p.margem_pct >= L.margem_pct_forte && cob !== "RUPTURA" && pRec >= 0.4) {
    out.MARGEM = { forca: clamp01(p.margem_pct / 0.5), confianca: 0.9, rationale: `margem de ${(p.margem_pct * 100).toFixed(1)}% (percentil de receita ${Math.round(pRec * 100)}) — sustenta a rentabilidade` };
  }
  // DESOVA — estoque em excesso. PARADO/∞ é urgente (forca 1.0, assume o papel primário);
  // excesso moderado (cobertura só acima do teto da categoria) fica como papel secundário.
  if (excesso) {
    const negativa = p.margem_pct != null && p.margem_pct < 0;
    const duro = cob === "PARADO" || p.cobertura_infinita;
    out.DESOVA = { forca: duro ? 1.0 : 0.8, confianca: 0.9, rationale: `cobertura ${p.cobertura_infinita ? "∞" : p.dias_cobertura + "d"} (${cob}) — estoque ${duro ? "parado" : "em excesso"}${negativa ? "; margem negativa: liquidar" : ""}` };
  }
  // COMPLEMENTAR — item de tíquete baixo que anda junto de outro
  if (pRec <= L.complementar_percentil_receita && cupons30 >= L.complementar_cupons_min && cob !== "RUPTURA") {
    out.COMPLEMENTAR = { forca: 0.5, confianca: 0.75, rationale: `baixa receita isolada (percentil ${Math.round(pRec * 100)}) mas ${cupons30} cupons/30d — anda de carona` };
  }
  // RECORRENCIA — categoria de recompra + muitos cupons ~1 unidade cada (proxy)
  if (RECORR.has(cat) && cupons30 >= L.recorrencia_cupons_min_30d && un30 > 0 && cupons30 / un30 >= L.recorrencia_cupons_por_unidade_min) {
    out.RECORRENCIA = { forca: 0.55, confianca: 0.45, rationale: `categoria de recompra; ${cupons30} cupons para ${un30} unidades/30d (≈1 por compra) — proxy de recorrência` };
  }
  // IMAGEM — categoria de posicionamento com tração
  if (IMG.has(cat) && ((tend != null && tend >= L.imagem_tendencia_pct) || pRec >= 0.6)) {
    out.IMAGEM = { forca: 0.5, confianca: 0.45, rationale: `categoria de imagem; tendência ${pctTxt(tend)}, receita percentil ${Math.round(pRec * 100)}` };
  }

  // se o produto está bloqueado por ruptura/margem, papéis "anunciar forte" não valem
  if (p.do_not_promote) {
    const tipos = new Set((p.do_not_promote.motivos || []).map((m) => m.tipo));
    if (tipos.has("RUPTURA")) { delete out.HERO; delete out.TRAFEGO; delete out.CHAMARIZ; }
    if (tipos.has("MARGEM")) { delete out.CHAMARIZ; delete out.MARGEM; }
  }
  return out;
}

function papelDeProduto(p) {
  const cand = avaliar(p);
  const nomes = Object.keys(cand).sort((a, b) => cand[b].forca - cand[a].forca);
  if (!nomes.length) {
    return {
      papel_primario: "GIRO",
      papeis: ["GIRO"],
      detalhe: [{ papel: "GIRO", forca: 0, confianca: 0.6, rationale: "sem sinal forte de papel — vende no fluxo normal", acao: CFG.papeis.GIRO.acao }],
      confianca: 0.6,
    };
  }
  const detalhe = nomes.map((n) => ({ papel: n, forca: r2(cand[n].forca), confianca: cand[n].confianca, rationale: cand[n].rationale, acao: CFG.papeis[n].acao }));
  return {
    papel_primario: nomes[0],
    papeis: nomes,
    detalhe,
    confianca: cand[nomes[0]].confianca,
  };
}

module.exports = { papelDeProduto, PAPEIS: CFG.papeis };
