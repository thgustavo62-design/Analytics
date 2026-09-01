// Fase 4 — Market Basket Analysis por cupom (lancamento + data).
//
// Determinístico. Para UMA loja, numa janela para trás a partir do último dia com venda:
//   support(A,B)      = cupons com A e B  ÷  total de cupons
//   confidence(A→B)   = cupons com A e B  ÷  cupons com A
//   lift(A,B)         = confidence(A→B)  ÷  support(B)     (>1 = compram juntos mais do que o acaso)
//
// Limites em config/basket-analysis.json evitam ruído (amostra pequena, coincidência).
// O resultado é materializado em cesta_pares para as telas e o Campaign Builder lerem rápido.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { normalizarEan } = require("./catalogo");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "basket-analysis.json"), "utf8"));
const NAO_MARKETAVEL = new Set(["diversos", "taxa de entrega", "taxa entrega", "desconto", "acrescimo", "arredondamento"]);
const ehLixo = (d) => NAO_MARKETAVEL.has(String(d || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim());
const DIA = 86400000;
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);
const round = (n, d) => (n == null ? null : Math.round((n + Number.EPSILON) * Math.pow(10, d ?? 4)) / Math.pow(10, d ?? 4));

function calcularCesta(loja, opts = {}) {
  const refDate = opts.refDate || db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja", pares: [] };
  const janelaDias = opts.janelaDias || CFG.janela_dias;
  const ini = addDias(refDate, -(janelaDias - 1));

  const linhas = db.linhasCestaJanela(loja, ini, refDate);
  // resolve cada linha para um produto do catálogo (EAN normalizado; senão descrição)
  const catPorEan = new Map();
  const catPorNorm = new Map();
  for (const row of db.db.prepare("SELECT id, ean, descricao_normalizada, COALESCE(descricao_manual,descricao) d, COALESCE(categoria_manual,categoria) c FROM produtos").all()) {
    if (row.ean) catPorEan.set(row.ean, row);
    else catPorNorm.set(row.descricao_normalizada, row);
  }
  const nomeNorm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  const cupons = new Map(); // key -> Set(produtoId)
  const contProduto = new Map(); // produtoId -> nº cupons
  const infoProduto = new Map(); // produtoId -> {descricao, categoria, ean}
  for (const l of linhas) {
    if (ehLixo(l.descricao)) continue;
    const ean = normalizarEan(l.barras);
    let prod = ean ? catPorEan.get(ean) : catPorNorm.get(nomeNorm(l.descricao));
    if (!prod || ehLixo(prod.d)) continue;
    const pid = prod.id;
    if (!infoProduto.has(pid)) infoProduto.set(pid, { descricao: prod.d || l.descricao, categoria: prod.c || null, ean: prod.ean || null });
    const ck = l.data + "#" + l.lancamento;
    if (!cupons.has(ck)) cupons.set(ck, new Set());
    cupons.get(ck).add(pid);
  }
  const totalCupons = cupons.size;
  if (totalCupons < CFG.min_cupons_total) {
    return { erro: `amostra insuficiente: ${totalCupons} cupons na janela (mínimo ${CFG.min_cupons_total})`, total_cupons: totalCupons, janela: { inicio: ini, fim: refDate }, pares: [] };
  }

  for (const set of cupons.values()) for (const pid of set) contProduto.set(pid, (contProduto.get(pid) || 0) + 1);

  // limita ao top-N produtos por frequência (combinatória)
  const topProdutos = [...contProduto.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CFG.max_produtos)
    .map(([pid]) => pid);
  const permitido = new Set(topProdutos);

  // conta pares co-ocorrentes
  const parCount = new Map(); // "a|b" (a<b) -> n
  for (const set of cupons.values()) {
    const ids = [...set].filter((p) => permitido.has(p)).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + "|" + ids[j];
        parCount.set(k, (parCount.get(k) || 0) + 1);
      }
  }

  const pares = [];
  for (const [k, nAB] of parCount) {
    if (nAB < CFG.min_cupons_par) continue;
    const [a, b] = k.split("|").map(Number);
    const nA = contProduto.get(a);
    const nB = contProduto.get(b);
    // ambos os itens precisam ser razoavelmente comuns p/ o lift ser confiável (mata
    // "lift 250" vindo de 6 cupons de dois produtos de nicho)
    if (Math.min(nA, nB) < (CFG.min_cupons_isolado || 0)) continue;
    const support = nAB / totalCupons;
    if (support < CFG.min_support) continue;
    const supB = nB / totalCupons;
    const confAB = nAB / nA;
    const confBA = nAB / nB;
    const lift = supB > 0 ? confAB / supB : 0;
    if (lift < CFG.min_lift) continue;
    const confMax = Math.max(confAB, confBA);
    if (confMax < CFG.min_confidence) continue;
    pares.push({
      produto_a: a, produto_b: b,
      desc_a: infoProduto.get(a).descricao, desc_b: infoProduto.get(b).descricao,
      ean_a: infoProduto.get(a).ean, ean_b: infoProduto.get(b).ean,
      cat_a: infoProduto.get(a).categoria, cat_b: infoProduto.get(b).categoria,
      cupons_a: nA, cupons_b: nB, cupons_ab: nAB,
      support: round(support, 5), confidence: round(confAB, 4), confidence_ba: round(confBA, 4), lift: round(lift, 3),
    });
  }
  pares.sort((x, y) => y.lift - x.lift);
  const materializar = pares.slice(0, CFG.max_pares_materializados);

  // trios (opcional): só sobre pares já fortes
  let trios = [];
  if (CFG.trios && CFG.trios.habilitado) {
    const fortes = new Set();
    for (const p of materializar) { fortes.add(p.produto_a); fortes.add(p.produto_b); }
    const trioCount = new Map();
    for (const set of cupons.values()) {
      const ids = [...set].filter((p) => fortes.has(p)).sort((a, b) => a - b);
      if (ids.length < 3) continue;
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          for (let l = j + 1; l < ids.length; l++) {
            const kk = ids[i] + "|" + ids[j] + "|" + ids[l];
            trioCount.set(kk, (trioCount.get(kk) || 0) + 1);
          }
    }
    for (const [kk, n] of trioCount) {
      if (n < CFG.trios.min_cupons) continue;
      const [a, b, c] = kk.split("|").map(Number);
      const support = n / totalCupons;
      const expected = (contProduto.get(a) / totalCupons) * (contProduto.get(b) / totalCupons) * (contProduto.get(c) / totalCupons);
      const lift = expected > 0 ? support / expected : 0;
      if (lift < CFG.trios.min_lift) continue;
      trios.push({
        produtos: [a, b, c],
        descricoes: [infoProduto.get(a).descricao, infoProduto.get(b).descricao, infoProduto.get(c).descricao],
        cupons: n, support: round(support, 5), lift: round(lift, 2),
      });
    }
    trios.sort((x, y) => y.lift - x.lift);
    trios = trios.slice(0, CFG.trios.max);
  }

  if (opts.materializar !== false) {
    db.salvarCestaPares(loja, ini, refDate, materializar);
  }

  return {
    loja,
    janela: { inicio: ini, fim: refDate, dias: janelaDias },
    total_cupons: totalCupons,
    produtos_considerados: topProdutos.length,
    pares: materializar,
    trios,
    parametros: CFG,
  };
}

// centralidade de cada produto na cesta (para o Opportunity Score) — soma de lift dos pares
// em que aparece, normalizada 0..1.
function centralidade(loja) {
  const { pares } = db.getCestaPares(loja, { limite: 2000 });
  const acc = new Map();
  for (const p of pares) {
    acc.set(p.produto_a, (acc.get(p.produto_a) || 0) + (p.lift - 1));
    acc.set(p.produto_b, (acc.get(p.produto_b) || 0) + (p.lift - 1));
  }
  const max = Math.max(1, ...acc.values());
  const out = new Map();
  for (const [pid, v] of acc) out.set(pid, v / max);
  return out;
}

// combos inteligentes: pega os pares de maior lift e anexa o retrato de marketing de cada perna
// (classe, cobertura, margem, oportunidade) vindo da Fase 2.
function combos(loja, opts = {}) {
  const { pares, janela } = db.getCestaPares(loja, { limite: opts.limite || 60 });
  if (!pares.length) return { loja, janela, combos: [], nota: "cesta ainda não materializada — rode /api/marketing/:loja/:periodo/baskets" };
  const mpa = require("./marketing-product-analytics");
  const analise = mpa.analisarProdutos(loja, opts);
  const porId = new Map((analise.produtos || []).map((p) => [p.produto_id, p]));
  const retrato = (pid) => {
    const p = porId.get(pid);
    if (!p) return null;
    return { classe: p.classe, cobertura: p.cobertura_rotulo, margem_pct: p.margem_pct, opportunity: p.opportunity.score, tendencia: p.tendencia.rotulo };
  };
  const combos = pares.map((p) => {
    const ra = retrato(p.produto_a);
    const rb = retrato(p.produto_b);
    // papel sugerido: âncora = maior receita/opportunity; isca = menor margem ou GIRO_URGENTE
    let ancora = "A", isca = "B";
    if (ra && rb) {
      if ((rb.opportunity || 0) > (ra.opportunity || 0)) { ancora = "B"; isca = "A"; }
      if (ra.classe === "GIRO_URGENTE") { isca = "A"; ancora = "B"; }
      if (rb.classe === "GIRO_URGENTE") { isca = "B"; ancora = "A"; }
    }
    const alerta = [];
    if (ra && ra.cobertura === "RUPTURA") alerta.push(`${p.desc_a}: risco de ruptura`);
    if (rb && rb.cobertura === "RUPTURA") alerta.push(`${p.desc_b}: risco de ruptura`);
    return {
      produto_a: { produto_id: p.produto_a, ean: p.ean_a, descricao: p.desc_a, ...(ra || {}) },
      produto_b: { produto_id: p.produto_b, ean: p.ean_b, descricao: p.desc_b, ...(rb || {}) },
      cupons_ab: p.cupons_ab, support: p.support, confidence: p.confidence, lift: p.lift,
      papel: { ancora, isca },
      margem_combinada_pct: ra && rb && ra.margem_pct != null && rb.margem_pct != null ? round((ra.margem_pct + rb.margem_pct) / 2, 4) : null,
      alertas: alerta,
      evidencia: { campo: "lift", valor: p.lift, fonte: `cesta_pares ${janela ? janela.inicio + ".." + janela.fim : ""}`, periodo: janela ? `${janela.inicio}..${janela.fim}` : null },
    };
  });
  return { loja, janela, combos };
}

module.exports = { calcularCesta, centralidade, combos };
