// Fase 2 — Marketing Product Intelligence.
//
// Camada DETERMINÍSTICA (nenhuma IA, nenhuma adivinhação). A partir das vendas por EAN de
// UMA loja + o histórico de estoque/custo/preço (quando existe), calcula por produto:
//   - unidades / receita / cupons em janelas de 7/14/30/60/90 dias
//   - venda média diária, tendência (janela recente x anterior)
//   - dias de cobertura (days-of-cover) = estoque_disponível / venda_média_diária_30d
//   - margem unitária e % — SÓ quando há custo cadastrado (senão fica null + flag)
//   - classe de marketing (HERO / TRÁFEGO / OPORTUNIDADE / GIRO_URGENTE / PROTEGIDO / COMPLEMENTAR / DEFESA / GIRO)
//   - Marketing Opportunity Score 0–100 com quebra por componente e nível de confiança
//   - lista "não anunciar" (do-not-promote) com motivo + substituto
//   - estoque parado / sem giro
//
// Toda conclusão carrega evidência: campo, valor, fonte e período.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { normalizarEan } = require("./catalogo");

const CFG_STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "marketing-stock.json"), "utf8"));
const CFG_SCORE = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "opportunity-score.json"), "utf8"));
const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));

const DIA = 86400000;
// pseudo-produtos que não são item de prateleira — nunca entram nas telas de marketing
const NAO_MARKETAVEL = new Set(["diversos", "taxa de entrega", "taxa entrega", "desconto", "acrescimo", "arredondamento"]);
function ehNaoMarketavel(descricao) {
  return NAO_MARKETAVEL.has(String(descricao || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim());
}
function addDias(iso, n) {
  return new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function lerp(x, x0, x1) {
  if (x1 === x0) return 0.5;
  return clamp01((x - x0) / (x1 - x0));
}
function round(n, d) {
  const f = Math.pow(10, d == null ? 2 : d);
  return n == null ? null : Math.round((n + Number.EPSILON) * f) / f;
}
// percentil (rank fracionário 0..1) de v dentro de uma lista já ordenada asc
function percentil(ordenada, v) {
  if (!ordenada.length) return 0;
  let lo = 0;
  for (let i = 0; i < ordenada.length; i++) if (ordenada[i] < v) lo = i + 1;
  return ordenada.length === 1 ? 1 : lo / (ordenada.length - 1);
}

function thresholdsCategoria(categoria) {
  const base = { ...CFG_STOCK.default };
  const over = CFG_STOCK.por_categoria && CFG_STOCK.por_categoria[categoria];
  return over ? { ...base, ...over } : base;
}

// -------- lift histórico de campanha por categoria (sinal real, determinístico) --------
// compara a receita média dos dias-de-campanha da categoria contra os demais dias, 90d.
function liftCampanhaPorCategoria(loja, refDate) {
  const ini = addDias(refDate, -89);
  const rows = db.vendasCategoriaPorData(loja, ini, refDate);
  const cfg = LOJAS_CFG[loja] || {};
  const diasPorCat = new Map(); // categoria -> Set(diaSemana)
  for (const c of cfg.campanhas || []) {
    for (const cat of c.categorias || []) {
      if (!diasPorCat.has(cat)) diasPorCat.set(cat, new Set());
      for (const d of c.dias || []) diasPorCat.get(cat).add(d);
    }
  }
  const acc = new Map(); // categoria -> { camp:[], fora:[] }
  for (const r of rows) {
    const dias = diasPorCat.get(r.categoria);
    if (!dias) continue;
    const dow = new Date(r.data + "T12:00:00").getDay();
    if (!acc.has(r.categoria)) acc.set(r.categoria, { camp: [], fora: [] });
    (dias.has(dow) ? acc.get(r.categoria).camp : acc.get(r.categoria).fora).push(r.receita);
  }
  const out = new Map();
  for (const [cat, o] of acc) {
    const mc = o.camp.length ? o.camp.reduce((s, x) => s + x, 0) / o.camp.length : 0;
    const mf = o.fora.length ? o.fora.reduce((s, x) => s + x, 0) / o.fora.length : 0;
    out.set(cat, mf > 0 ? mc / mf : null);
  }
  return out;
}

// -------------------------- núcleo --------------------------

// memo curto: numa rodada de coleta/detecção, analisarProdutos é chamado ~8x por loja com
// o mesmo contexto. TTL de 45s colapsa isso numa vez só; expira sozinho pra não servir dado
// velho depois. Os "recortes" (recomendados/naoAnunciar/estoqueParado) NÃO mutam o retorno.
const _memo = new Map();
function _memoKey(loja, refDate, opts) {
  const c = opts.concorrenciaCategorias instanceof Set ? opts.concorrenciaCategorias.size : -1;
  const k = opts.cestaCentralidade instanceof Map ? opts.cestaCentralidade.size : -1;
  return `${loja}|${refDate}|c${c}|k${k}`;
}

function analisarProdutos(loja, opts = {}) {
  const refDate = opts.refDate || db.getUltimaDataVenda(loja);
  if (!refDate) return { erro: "sem vendas para esta loja", produtos: [] };
  const mk = _memoKey(loja, refDate, opts);
  const hit = _memo.get(mk);
  if (hit && Date.now() - hit.t < 45000) return hit.v;
  const lid = db.lojaId(loja);

  const JAN = [7, 14, 30, 60, 90];
  const janelas = {};
  for (const n of JAN) janelas[n] = db.vendasPorProdutoJanela(loja, addDias(refDate, -(n - 1)), refDate);
  // tendência: 14d recentes [ref-13..ref] vs 14d anteriores [ref-27..ref-14] (ambas cabem
  // dentro de um mês típico de upload — evita comparar contra um mês vazio).
  const prev14 = db.vendasPorProdutoJanela(loja, addDias(refDate, -27), addDias(refDate, -14));

  // indexa por chave estável (EAN normalizado, senão norm:descrição)
  const chave = (barras, descricao) => normalizarEan(barras) || "d:" + String(descricao || "").toLowerCase().trim();
  const idx = new Map();
  const push = (n, rows) => {
    for (const r of rows) {
      if (ehNaoMarketavel(r.descricao)) continue;
      const k = chave(r.barras, r.descricao);
      if (!idx.has(k)) idx.set(k, { barras: r.barras, descricao: r.descricao, j: {}, prev14: null });
      idx.get(k).j[n] = r;
      if ((r.descricao || "").length > (idx.get(k).descricao || "").length) idx.get(k).descricao = r.descricao;
    }
  };
  for (const n of JAN) push(n, janelas[n]);
  for (const r of prev14) {
    const k = chave(r.barras, r.descricao);
    if (idx.has(k)) idx.get(k).prev14 = r;
  }

  const catalogoPorEan = new Map();
  const catalogoPorNorm = new Map();
  for (const p of db.todosProdutos()) {
    if (p.ean) catalogoPorEan.set(p.ean, p);
  }
  // norm precisa da linha crua; refazemos um mapa leve
  for (const row of db.db.prepare("SELECT id, ean, descricao_normalizada FROM produtos WHERE ean IS NULL").all()) {
    catalogoPorNorm.set(row.descricao_normalizada, row.id);
  }

  const freshness = db.freshnessCatalogo(loja);
  const temEstoque = !!freshness.estoque.ultima;
  const temCusto = !!freshness.custo.ultima;
  const temPreco = !!freshness.preco.ultima;
  const liftCamp = liftCampanhaPorCategoria(loja, refDate);
  const concorrenciaCategorias = opts.concorrenciaCategorias instanceof Set ? opts.concorrenciaCategorias : new Set();
  const cestaCentralidade = opts.cestaCentralidade instanceof Map ? opts.cestaCentralidade : null;

  // primeiro passe: métricas cruas por produto
  const brutos = [];
  for (const [k, v] of idx) {
    const ean = normalizarEan(v.barras);
    let prod = ean ? catalogoPorEan.get(ean) : null;
    let produtoId = prod ? prod.id : null;
    if (!produtoId && !ean) produtoId = catalogoPorNorm.get(String(v.descricao || "").toLowerCase().trim()) || null;
    const categoria = (prod && prod.categoria) || (v.j[90] && v.j[90].categoria) || "Medicamentos/Outros";

    const u = {};
    for (const n of JAN) u[n] = (v.j[n] && v.j[n].unidades) || 0;
    const receita90 = (v.j[90] && v.j[90].receita) || 0;
    const receita30 = (v.j[30] && v.j[30].receita) || 0;
    const cupons30 = (v.j[30] && v.j[30].cupons) || 0;
    const cupons90 = (v.j[90] && v.j[90].cupons) || 0;
    const uRec14 = (v.j[14] && v.j[14].unidades) || 0;
    const uPrev14 = (v.prev14 && v.prev14.unidades) || 0;

    const vmd30 = u[30] / 30;
    const vmd7 = u[7] / 7;
    // tendência: venda média diária dos 14d recentes x 14d anteriores (clamp p/ exibição)
    let tendPct = null;
    let tendRot = "SEM_BASE";
    if (uRec14 + uPrev14 >= 4) {
      const raw = uPrev14 > 0 ? ((uRec14 - uPrev14) / uPrev14) * 100 : (uRec14 > 0 ? 200 : 0);
      tendPct = round(Math.max(-300, Math.min(300, raw)), 1);
      const lim = CFG_SCORE.tendencia.limite_pct;
      tendRot = tendPct >= lim ? "SUBINDO" : tendPct <= -lim ? "CAINDO" : "ESTAVEL";
    }

    let estoqueAtual = null;
    if (temEstoque && produtoId) {
      const e = db.getEstoqueEm(lid, produtoId, refDate);
      if (e) estoqueAtual = e.disponivel != null ? e.disponivel : e.quantidade;
    }
    let custoAtual = null;
    let precoAtual = null;
    if (temCusto && produtoId) {
      const c = db.getCustoEm(lid, produtoId, refDate);
      if (c) custoAtual = c.custo;
    }
    if (temPreco && produtoId) {
      const p = db.getPrecoEm(lid, produtoId, refDate, "normal");
      if (p) precoAtual = p.preco;
    }
    const precoPraticado = u[30] > 0 ? round(receita30 / u[30], 2) : (u[90] > 0 ? round(receita90 / u[90], 2) : null);
    const precoRef = precoAtual != null ? precoAtual : precoPraticado;
    const margemUnit = custoAtual != null && precoRef != null ? round(precoRef - custoAtual, 2) : null;
    const margemPct = margemUnit != null && precoRef ? round(margemUnit / precoRef, 4) : null;

    const th = thresholdsCategoria(categoria);
    let diasCobertura = null;
    let coberturaRot = "SEM_ESTOQUE";
    if (estoqueAtual != null) {
      if (vmd30 > 0) {
        diasCobertura = round(estoqueAtual / vmd30, 1);
        coberturaRot =
          diasCobertura <= th.ruptura ? "RUPTURA" :
          diasCobertura <= th.atencao ? "ATENCAO" :
          diasCobertura <= th.normal_max ? "NORMAL" :
          diasCobertura <= th.parado ? "OPORTUNIDADE" : "PARADO";
      } else {
        diasCobertura = estoqueAtual > 0 ? Infinity : 0;
        coberturaRot = estoqueAtual > 0 ? "PARADO" : "SEM_ESTOQUE";
      }
    }

    brutos.push({
      chave: k, produto_id: produtoId, ean: ean || null,
      descricao: v.descricao, categoria,
      unidades: u,
      receita: { d30: round(receita30, 2), d90: round(receita90, 2) },
      cupons: { d30: cupons30, d90: cupons90 },
      venda_media_diaria: { d7: round(vmd7, 3), d30: round(vmd30, 3) },
      tendencia: { pct: tendPct, rotulo: tendRot },
      estoque_atual: estoqueAtual,
      dias_cobertura: diasCobertura === Infinity ? null : diasCobertura,
      cobertura_infinita: diasCobertura === Infinity,
      cobertura_rotulo: coberturaRot,
      custo_atual: custoAtual, preco_atual: precoAtual, preco_praticado: precoPraticado,
      margem_unitaria: margemUnit, margem_pct: margemPct,
      _dias_sem_venda: v.j[90] && v.j[90].ultima ? Math.round((new Date(refDate) - new Date(v.j[90].ultima)) / DIA) : null,
    });
  }

  // segundo passe: percentis + score + classe (precisa da população toda)
  const recOrd = brutos.map((b) => b.receita.d30).sort((a, b) => a - b);
  const cupOrd = brutos.map((b) => b.cupons.d30).sort((a, b) => a - b);
  const vmdOrd = brutos.map((b) => b.venda_media_diaria.d30).sort((a, b) => a - b);
  const th0 = CFG_SCORE.classe_thresholds;

  for (const b of brutos) {
    const pRec = percentil(recOrd, b.receita.d30);
    const pCup = percentil(cupOrd, b.cupons.d30);
    const pVmd = percentil(vmdOrd, b.venda_media_diaria.d30);

    // ---- componentes do Opportunity Score (cada um 0..1) ----
    const comp = {};
    const ausentes = [];

    comp.demanda = { valor: round(pVmd, 3), fonte: `venda_media_diaria_30d=${b.venda_media_diaria.d30} (percentil ${Math.round(pVmd * 100)})`, periodo: `${addDias(refDate, -29)}..${refDate}` };

    let tv = 0.5;
    if (b.tendencia.rotulo === "SUBINDO") tv = 0.85 + 0.15 * clamp01((b.tendencia.pct - CFG_SCORE.tendencia.limite_pct) / 100);
    else if (b.tendencia.rotulo === "CAINDO") tv = 0.2 * clamp01(1 + b.tendencia.pct / 100);
    else if (b.tendencia.rotulo === "ESTAVEL") tv = 0.5;
    else { tv = 0.5; ausentes.push("tendencia (base curta)"); }
    comp.tendencia = { valor: round(tv, 3), fonte: `unid 14d recentes vs 14d anteriores; var ${b.tendencia.pct == null ? "s/ base" : b.tendencia.pct + "%"}`, periodo: `${addDias(refDate, -27)}..${refDate}` };

    let mv;
    if (b.margem_pct != null) {
      mv = lerp(b.margem_pct, CFG_SCORE.margem.piso_pct, CFG_SCORE.margem.teto_pct);
      comp.margem = { valor: round(mv, 3), fonte: `margem_pct=${(b.margem_pct * 100).toFixed(1)}% (preço ${b.preco_atual ?? b.preco_praticado} − custo ${b.custo_atual})`, periodo: refDate };
    } else {
      mv = 0.5;
      ausentes.push("margem (sem custo cadastrado)");
      comp.margem = { valor: 0.5, fonte: "sem custo cadastrado — neutro", periodo: refDate };
    }

    let ev;
    if (b.estoque_atual != null) {
      const th = thresholdsCategoria(b.categoria);
      if (b.cobertura_rotulo === "RUPTURA") ev = 0.08;
      else if (b.cobertura_rotulo === "ATENCAO") ev = 0.3;
      else if (b.cobertura_rotulo === "NORMAL") ev = 0.6;
      else if (b.cobertura_rotulo === "OPORTUNIDADE") ev = 0.9;
      else if (b.cobertura_rotulo === "PARADO") ev = 1.0;
      else ev = 0.2;
      comp.estoque = { valor: ev, fonte: `dias_cobertura=${b.cobertura_infinita ? "∞" : b.dias_cobertura} (${b.cobertura_rotulo}); estoque ${b.estoque_atual}`, periodo: refDate };
    } else {
      ev = 0.5;
      ausentes.push("estoque (sem feed de estoque)");
      comp.estoque = { valor: 0.5, fonte: "sem feed de estoque — neutro", periodo: refDate };
    }

    let cv = 0.5;
    const lc = liftCamp.get(b.categoria);
    if (lc != null) {
      cv = lerp(lc, 0.85, 1.4);
      comp.campanha_historica = { valor: round(cv, 3), fonte: `lift receita da categoria "${b.categoria}" nos dias de campanha = ${lc.toFixed(2)}x`, periodo: `${addDias(refDate, -89)}..${refDate}` };
    } else {
      ausentes.push("campanha_historica (categoria fora do calendário)");
      comp.campanha_historica = { valor: 0.5, fonte: "categoria não está no calendário de campanhas — neutro", periodo: refDate };
    }

    let kv = 0.4;
    if (concorrenciaCategorias.has(b.categoria)) { kv = 0.75; }
    comp.concorrencia = { valor: kv, fonte: concorrenciaCategorias.has(b.categoria) ? `concorrente com oferta abaixo do nosso na categoria "${b.categoria}"` : "sem pressão de concorrência registrada na categoria", periodo: refDate };
    if (!opts.concorrenciaCategorias) ausentes.push("concorrencia (sem coleta no período)");

    let xv = 0.5;
    if (cestaCentralidade && b.produto_id != null && cestaCentralidade.has(b.produto_id)) {
      xv = clamp01(cestaCentralidade.get(b.produto_id));
      comp.cesta = { valor: round(xv, 3), fonte: `centralidade na cesta (pares com lift alto) = ${xv.toFixed(2)}`, periodo: `${addDias(refDate, -89)}..${refDate}` };
    } else {
      ausentes.push("cesta (sem par relevante)");
      comp.cesta = { valor: 0.5, fonte: "sem par de cesta relevante — neutro", periodo: refDate };
    }

    const pesos = CFG_SCORE.pesos;
    const mapPeso = { demanda: "demanda", tendencia: "tendencia", margem: "margem", estoque: "estoque", campanha_historica: "campanha_historica", concorrencia: "concorrencia", cesta: "cesta" };
    let score = 0;
    let somaPesos = 0;
    let pesoComDado = 0;
    for (const nome of Object.keys(mapPeso)) {
      const w = pesos[nome] || 0;
      const c = comp[nome];
      c.peso = w;
      c.contribuicao = round(c.valor * w * 100, 1);
      score += c.valor * w;
      somaPesos += w;
      const neutroPorAusencia = ausentes.some((a) => a.startsWith(nome));
      if (!neutroPorAusencia) pesoComDado += w;
    }
    score = round((score / (somaPesos || 1)) * 100, 1);
    const confianca = round(pesoComDado / (somaPesos || 1), 2);
    const rot = score >= CFG_SCORE.rotulos.alto ? "ALTA" : score >= CFG_SCORE.rotulos.medio ? "MEDIA" : "BAIXA";

    b.opportunity = { score, rotulo: rot, confianca, componentes: comp, dados_ausentes: ausentes };

    // ---- classe de marketing (regras determinísticas) ----
    let classe = "GIRO";
    const subindoForte = b.tendencia.pct != null && b.tendencia.pct >= th0.oportunidade_tendencia_pct;
    const cobOk = b.estoque_atual == null || ["NORMAL", "OPORTUNIDADE", "ATENCAO"].includes(b.cobertura_rotulo);
    if (b.cobertura_rotulo === "RUPTURA" || (b.margem_pct != null && b.margem_pct < CFG_STOCK.margem_pct_minima_para_anunciar)) {
      classe = "PROTEGIDO";
    } else if (b.cobertura_rotulo === "PARADO" || (b.estoque_atual != null && b.dias_cobertura != null && b.dias_cobertura >= th0.giro_urgente_cobertura)) {
      classe = "GIRO_URGENTE";
    } else if (concorrenciaCategorias.has(b.categoria) && pRec >= 0.6) {
      classe = "DEFESA";
    } else if (pRec >= th0.hero_percentil_receita && cobOk) {
      classe = "HERO";
    } else if (pCup >= th0.trafego_percentil_cupons && cobOk) {
      classe = "TRAFEGO";
    } else if (subindoForte && cobOk) {
      classe = "OPORTUNIDADE";
    } else if (pRec <= th0.complementar_percentil_receita && b.cupons.d30 >= 2) {
      classe = "COMPLEMENTAR";
    }
    b.classe = classe;
    b._percentis = { receita: round(pRec, 3), cupons: round(pCup, 3), vmd: round(pVmd, 3) };
  }

  // ---- do-not-promote + substitutos ----
  const porCategoria = new Map();
  for (const b of brutos) {
    if (!porCategoria.has(b.categoria)) porCategoria.set(b.categoria, []);
    porCategoria.get(b.categoria).push(b);
  }
  function substitutoDe(b) {
    const pares = (porCategoria.get(b.categoria) || [])
      .filter((x) => x !== b && x.venda_media_diaria.d30 > 0 && !x._dnp && x.cobertura_rotulo !== "RUPTURA")
      .filter((x) => b.margem_pct == null || x.margem_pct == null || x.margem_pct >= b.margem_pct - 0.02)
      .sort((a, c) => c.opportunity.score - a.opportunity.score);
    const s = pares[0];
    return s ? { produto_id: s.produto_id, ean: s.ean, descricao: s.descricao, opportunity_score: s.opportunity.score, motivo: `mesma categoria, cobertura ${s.cobertura_rotulo}, score ${s.opportunity.score}` } : null;
  }
  const th0b = CFG_STOCK.campanha_dias_min;
  for (const b of brutos) {
    const motivos = [];
    if (b.estoque_atual != null && b.dias_cobertura != null && b.dias_cobertura < th0b && b.tendencia.rotulo !== "CAINDO") {
      motivos.push({ tipo: "RUPTURA", texto: `cobertura de ${b.dias_cobertura}d < mínimo de ${th0b}d para campanha — anunciar geraria ruptura`, evidencia: { campo: "dias_cobertura", valor: b.dias_cobertura, fonte: "produto_estoque + venda_media_diaria_30d", periodo: refDate } });
    }
    if (b.margem_pct != null && b.margem_pct < CFG_STOCK.margem_pct_minima_para_anunciar) {
      motivos.push({ tipo: "MARGEM", texto: `margem de ${(b.margem_pct * 100).toFixed(1)}% abaixo do piso de ${(CFG_STOCK.margem_pct_minima_para_anunciar * 100).toFixed(0)}% — desconto destrói rentabilidade`, evidencia: { campo: "margem_pct", valor: b.margem_pct, fonte: "produto_custo + produto_preco", periodo: refDate } });
    }
    if (b._dias_sem_venda != null && b._dias_sem_venda > CFG_STOCK.sem_giro_dias && b.unidades[90] === 0) {
      motivos.push({ tipo: "SEM_GIRO", texto: `sem venda há ${b._dias_sem_venda}d — campanha de anúncio não tem demanda para sustentar`, evidencia: { campo: "ultima_venda", valor: b._dias_sem_venda + "d", fonte: "vendas_transacoes", periodo: `${addDias(refDate, -89)}..${refDate}` } });
    }
    if (motivos.length) { b._dnp = true; b.do_not_promote = { motivos }; }
    else b.do_not_promote = null;
  }
  for (const b of brutos) if (b.do_not_promote) b.do_not_promote.substituto = substitutoDe(b);

  // limpa internos e ordena por oportunidade
  const produtos = brutos
    .map((b) => {
      const { chave, _dnp, _dias_sem_venda, _percentis, cobertura_infinita, ...pub } = b;
      pub.percentis = _percentis;
      pub.dias_sem_venda = _dias_sem_venda;
      pub.cobertura_infinita = cobertura_infinita;
      return pub;
    })
    .sort((a, c) => c.opportunity.score - a.opportunity.score);

  // curva ABC por receita 90d — marca cada produto com .abc (A/B/C)
  let abcResumo = null;
  try { abcResumo = require("./marketing/abc").classificarProdutosABC(produtos); } catch (e) { /* opcional */ }

  const resultado = {
    loja,
    refDate,
    abc: abcResumo,
    feeds: { estoque: temEstoque, custo: temCusto, preco: temPreco, freshness },
    dados_ausentes_globais: [
      !temEstoque && "estoque (days-of-cover, ruptura, estoque parado indisponíveis)",
      !temCusto && "custo (margem, campaign margin sacrifice indisponíveis)",
      !temPreco && "preço de tabela (usando preço médio praticado como referência)",
    ].filter(Boolean),
    total: produtos.length,
    produtos,
  };
  _memo.set(mk, { t: Date.now(), v: resultado });
  return resultado;
}

// ------- recortes prontos para as rotas -------

function recomendados(loja, opts = {}) {
  const r = analisarProdutos(loja, opts);
  if (r.erro) return r;
  const limite = opts.limite || 40;
  const base = r.produtos.filter((p) => !p.do_not_promote && p.opportunity.score >= (CFG_SCORE.rotulos.medio - 5));
  // por padrão esconde a cauda longa (classe C); opts.incluirC traz tudo
  const semC = opts.incluirC ? base : base.filter((p) => p.abc !== "C");
  return { ...r, produtos: semC.slice(0, limite), ocultos_classe_c: base.length - semC.length };
}

function naoAnunciar(loja, opts = {}) {
  const r = analisarProdutos(loja, opts);
  if (r.erro) return r;
  const todos = r.produtos.filter((p) => p.do_not_promote);
  const limite = opts.limite || 80;
  return { ...r, total_bloqueados: todos.length, produtos: todos.slice(0, limite) };
}

function estoqueParado(loja, opts = {}) {
  const r = analisarProdutos(loja, opts);
  if (r.erro) return r;
  const limite = opts.limite || 80;
  if (!r.feeds.estoque) {
    // sem feed de estoque: melhor proxy honesto é "sem giro" (não venderam nada em 45d+)
    const todos = r.produtos
      .filter((p) => p.dias_sem_venda != null && p.dias_sem_venda > CFG_STOCK.sem_giro_dias)
      .sort((a, b) => (b.dias_sem_venda || 0) - (a.dias_sem_venda || 0));
    return { ...r, modo: "sem_giro_proxy", total_parados: todos.length, produtos: todos.slice(0, limite) };
  }
  const todos = r.produtos
    .filter((p) => p.cobertura_rotulo === "PARADO" || p.cobertura_infinita || (p.dias_cobertura != null && p.dias_cobertura > thresholdsCategoria(p.categoria).parado))
    .map((p) => ({
      ...p,
      capital_parado: p.custo_atual != null && p.estoque_atual != null ? round(p.custo_atual * p.estoque_atual, 2) : (p.preco_praticado != null && p.estoque_atual != null ? round(p.preco_praticado * p.estoque_atual, 2) : null),
      acoes_marketing: [
        "usar como CHAMARIZ (desconto agressivo) numa campanha de categoria",
        "montar COMBO com um HERO da mesma cesta",
        p.margem_pct != null && p.margem_pct > 0.15 ? "liquidação com margem ainda positiva" : "liquidação para recuperar capital",
      ],
    }))
    .sort((a, b) => (b.capital_parado || 0) - (a.capital_parado || 0));
  return {
    ...r, modo: "estoque",
    total_parados: todos.length,
    capital_parado_total: round(todos.reduce((s, p) => s + (p.capital_parado || 0), 0), 2),
    produtos: todos.slice(0, limite),
  };
}

function produtoPorEan(loja, ean, opts = {}) {
  const r = analisarProdutos(loja, opts);
  if (r.erro) return r;
  const alvo = normalizarEan(ean);
  const p = r.produtos.find((x) => x.ean === alvo);
  if (!p) return { erro: "produto não encontrado nas vendas da loja no período", ean: alvo };
  return { loja, refDate: r.refDate, feeds: r.feeds, produto: p };
}

module.exports = {
  analisarProdutos,
  recomendados,
  naoAnunciar,
  estoqueParado,
  produtoPorEan,
  liftCampanhaPorCategoria,
  thresholdsCategoria,
};
