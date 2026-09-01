// Fase 3 — Campanhas: eficiência, Campaign Builder e Offer Simulator.
//
// Tudo determinístico. A IA nunca entra aqui e NUNCA se promete venda futura — o simulador
// devolve cenários rotulados (conservador / provável / agressivo) a partir do lift histórico
// já observado, sempre com o aviso de que é projeção.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const mpa = require("./marketing-product-analytics");
const { normalizarEan } = require("./catalogo");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));
const CFG_STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "marketing-stock.json"), "utf8"));
const DIA = 86400000;
const addDias = (iso, n) => new Date(new Date(iso + "T12:00:00").getTime() + n * DIA).toISOString().slice(0, 10);
const round = (n, d) => (n == null ? null : Math.round((n + Number.EPSILON) * Math.pow(10, d ?? 2)) / Math.pow(10, d ?? 2));
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ---------------------------------------------------------------------------
// 1) EFICIÊNCIA de uma campanha recorrente do calendário (config/lojas.json)
//    Compara os dias-de-campanha da categoria contra os demais dias, na janela.
// ---------------------------------------------------------------------------

function eficienciaCalendario(loja, { nome, janelaDias = 90, refDate } = {}) {
  const ref = refDate || db.getUltimaDataVenda(loja);
  if (!ref) return { erro: "sem vendas para esta loja" };
  const cfg = LOJAS_CFG[loja] || {};
  const camp = (cfg.campanhas || []).find((c) => c.nome === nome);
  if (!camp) return { erro: `campanha "${nome}" não está no calendário de ${loja}`, disponiveis: (cfg.campanhas || []).map((c) => c.nome) };

  const ini = addDias(ref, -(janelaDias - 1));
  const rows = db.vendasCategoriaPorData(loja, ini, ref);
  const cats = new Set(camp.categorias || []);
  const dias = new Set(camp.dias || []);

  const campDias = new Map(); // data -> receita/unid da categoria
  const foraDias = new Map();
  for (const r of rows) {
    if (!cats.has(r.categoria)) continue;
    const dow = new Date(r.data + "T12:00:00").getDay();
    const alvo = dias.has(dow) ? campDias : foraDias;
    const cur = alvo.get(r.data) || { receita: 0, unidades: 0 };
    cur.receita += r.receita;
    cur.unidades += r.unidades || 0;
    alvo.set(r.data, cur);
  }
  const cR = [...campDias.values()].map((x) => x.receita);
  const fR = [...foraDias.values()].map((x) => x.receita);
  const cU = [...campDias.values()].map((x) => x.unidades);
  const fU = [...foraDias.values()].map((x) => x.unidades);

  const baseReceita = media(fR);
  const campReceita = media(cR);
  const baseUnid = media(fU);
  const campUnid = media(cU);
  const demandLiftReceita = baseReceita > 0 ? round(campReceita / baseReceita, 3) : null;
  const demandLiftUnid = baseUnid > 0 ? round(campUnid / baseUnid, 3) : null;

  const amostraOk = cR.length >= 4 && fR.length >= 6;

  // feeds ausentes → métricas dependentes ficam null + flag (nunca inventadas)
  const feeds = db.freshnessCatalogo(loja);
  const ausentes = [];
  if (!feeds.estoque.ultima) ausentes.push("SELL_THROUGH e STOCK_IMPACT (sem feed de estoque)");
  if (!feeds.custo.ultima) ausentes.push("MARGIN_SACRIFICE (sem feed de custo)");

  let efficiencyScore = null;
  let veredito = "INCONCLUSIVO";
  if (amostraOk && demandLiftReceita != null) {
    // sem custo/estoque, o score é guiado pelo lift de demanda (ancorado: 1.0x→50, 2.0x→100, 0.5x→0)
    efficiencyScore = round(Math.max(0, Math.min(100, (demandLiftReceita - 0.5) * (50 / 0.5))), 0);
    veredito =
      demandLiftReceita >= 1.5 ? "EXCELENTE" :
      demandLiftReceita >= 1.25 ? "BOA" :
      demandLiftReceita >= 1.08 ? "ACEITAVEL" :
      demandLiftReceita >= 0.95 ? "FRACA" : "DESTRUTIVA";
    if (veredito === "DESTRUTIVA" && feeds.custo.ultima == null) veredito = "FRACA"; // sem custo não dá pra afirmar destruição de margem
  }

  return {
    loja, campanha: nome, categorias: camp.categorias, dias_semana: camp.dias,
    janela: { inicio: ini, fim: ref, dias: janelaDias },
    amostra: { dias_campanha: cR.length, dias_fora: fR.length, suficiente: amostraOk },
    metricas: {
      receita_media_dia_campanha: round(campReceita, 2),
      receita_media_dia_fora: round(baseReceita, 2),
      unid_media_dia_campanha: round(campUnid, 1),
      unid_media_dia_fora: round(baseUnid, 1),
      DEMAND_LIFT_receita: demandLiftReceita,
      DEMAND_LIFT_unidades: demandLiftUnid,
      SELL_THROUGH: null,
      MARGIN_SACRIFICE: null,
      STOCK_IMPACT: null,
      EFFICIENCY_SCORE: efficiencyScore,
    },
    veredito,
    dados_ausentes: ausentes,
    evidencia: {
      campo: "DEMAND_LIFT_receita", valor: demandLiftReceita,
      fonte: `receita diária média da(s) categoria(s) [${(camp.categorias || []).join(", ")}] nos dias ${JSON.stringify(camp.dias)} vs demais dias`,
      periodo: `${ini}..${ref}`,
    },
    aviso: "Leitura observacional: mede correlação dia-da-semana × categoria, não isola efeito de preço, clima, pagamento de salário ou concorrência.",
  };
}

function eficienciaTodasDoCalendario(loja, opts = {}) {
  const cfg = LOJAS_CFG[loja] || {};
  return (cfg.campanhas || []).map((c) => eficienciaCalendario(loja, { ...opts, nome: c.nome }));
}

// ---------------------------------------------------------------------------
// 2) CAMPAIGN BUILDER — monta um elenco de produtos por papel.
// ---------------------------------------------------------------------------

const PAPEIS = ["CHAMARIZ", "HERO", "MARGEM", "GIRO", "COMPLEMENTAR", "DEFESA"];

function campaignBuilder(loja, opts = {}) {
  const objetivo = opts.objetivo || "GIRAR_ESTOQUE";
  const categorias = opts.categorias && opts.categorias.length ? new Set(opts.categorias) : null;
  const porPapel = opts.porPapel || 4;

  const analise = mpa.analisarProdutos(loja, opts);
  if (analise.erro) return analise;
  let pool = analise.produtos;
  if (categorias) pool = pool.filter((p) => categorias.has(p.categoria));

  const evitar = pool.filter((p) => p.do_not_promote).map((p) => ({
    produto_id: p.produto_id, ean: p.ean, descricao: p.descricao, categoria: p.categoria,
    motivos: p.do_not_promote.motivos.map((m) => m.texto),
    substituto: p.do_not_promote.substituto,
  }));
  const promoviveis = pool.filter((p) => !p.do_not_promote);

  const usados = new Set();
  const take = (arr, n) => {
    const out = [];
    for (const p of arr) {
      if (usados.has(p.produto_id ?? p.chave ?? p.ean)) continue;
      out.push(p);
      usados.add(p.produto_id ?? p.chave ?? p.ean);
      if (out.length >= n) break;
    }
    return out;
  };
  const fmt = (p, motivo) => ({
    produto_id: p.produto_id, ean: p.ean, descricao: p.descricao, categoria: p.categoria,
    classe: p.classe, opportunity: p.opportunity.score, cobertura: p.cobertura_rotulo,
    tendencia: p.tendencia.rotulo, margem_pct: p.margem_pct,
    preco_ref: p.preco_atual ?? p.preco_praticado,
    motivo,
    evidencia: { campo: "opportunity.score", valor: p.opportunity.score, fonte: "marketing-product-analytics", periodo: analise.refDate },
  });

  const byOpp = [...promoviveis].sort((a, b) => b.opportunity.score - a.opportunity.score);
  const chamariz = take(
    byOpp.filter((p) => p.classe === "TRAFEGO" || p.classe === "GIRO_URGENTE" || (p.percentis && p.percentis.cupons >= 0.8)),
    porPapel
  ).map((p) => fmt(p, p.classe === "GIRO_URGENTE" ? "alto giro de cupom + estoque sobrando: chamariz que ainda desova estoque" : "alta penetração de cupom: puxa fluxo para a loja"));
  const hero = take(byOpp.filter((p) => p.classe === "HERO" || (p.percentis && p.percentis.receita >= 0.8)), porPapel)
    .map((p) => fmt(p, "top de receita com cobertura saudável: sustenta o faturamento da campanha"));
  const comCusto = [...promoviveis].filter((p) => p.margem_pct != null);
  let margem;
  if (comCusto.length) {
    margem = take(comCusto.sort((a, b) => b.margem_pct - a.margem_pct), porPapel)
      .map((p) => fmt(p, `margem ${(p.margem_pct * 100).toFixed(1)}%: banca o desconto dos chamarizes`));
  } else {
    // sem feed de custo: proxy declarado — preço praticado mais alto = mais folga provável
    margem = take(
      [...promoviveis].filter((p) => (p.preco_atual ?? p.preco_praticado) != null && p.classe !== "TRAFEGO").sort((a, b) => (b.preco_atual ?? b.preco_praticado) - (a.preco_atual ?? a.preco_praticado)),
      porPapel
    ).map((p) => ({ ...fmt(p, `PROXY (sem custo cadastrado): preço praticado R$ ${(p.preco_atual ?? p.preco_praticado).toFixed(2)} — provável folga de margem`), proxy: true }));
  }
  const giro = take(byOpp.filter((p) => p.classe === "GIRO_URGENTE" || p.cobertura_rotulo === "PARADO" || p.cobertura_infinita), porPapel)
    .map((p) => fmt(p, "estoque parado/sobrando: campanha para recuperar capital"));
  const defesa = take(byOpp.filter((p) => p.classe === "DEFESA"), porPapel)
    .map((p) => fmt(p, "categoria sob pressão de concorrência: presença para não perder o cliente"));

  // COMPLEMENTAR: parceiros de cesta dos heroes já escolhidos
  const cesta = db.getCestaPares(loja, { limite: 1000 });
  const heroIds = new Set(hero.map((h) => h.produto_id));
  const compIds = new Set();
  for (const par of cesta.pares) {
    if (heroIds.has(par.produto_a)) compIds.add(par.produto_b);
    if (heroIds.has(par.produto_b)) compIds.add(par.produto_a);
  }
  const complementar = take(
    byOpp.filter((p) => compIds.has(p.produto_id) && !heroIds.has(p.produto_id)),
    porPapel
  ).map((p) => fmt(p, "compra junto com um HERO da campanha (cesta): eleva o ticket"));

  const elenco = { CHAMARIZ: chamariz, HERO: hero, MARGEM: margem, GIRO: giro, COMPLEMENTAR: complementar, DEFESA: defesa };

  const briefing = gerarBriefing(loja, objetivo, opts.categorias || [], elenco, evitar, analise.refDate);

  return {
    loja, objetivo, categorias: opts.categorias || null, refDate: analise.refDate,
    feeds: analise.feeds, dados_ausentes_globais: analise.dados_ausentes_globais,
    elenco, evitar, briefing,
  };
}

function gerarBriefing(loja, objetivo, categorias, elenco, evitar, refDate) {
  const L = [];
  L.push(`BRIEFING DE CAMPANHA — ${loja}`);
  L.push(`Objetivo: ${objetivo}`);
  if (categorias.length) L.push(`Categorias-foco: ${categorias.join(", ")}`);
  L.push(`Base de dados: vendas até ${refDate}. Números pré-calculados pelo backend — sem estimativa da IA.`);
  L.push("");
  for (const papel of PAPEIS) {
    const itens = elenco[papel] || [];
    if (!itens.length) continue;
    L.push(`## ${papel}`);
    for (const it of itens) L.push(`- ${it.descricao} — ${it.motivo} (opportunity ${it.opportunity}, ${it.cobertura})`);
    L.push("");
  }
  if (evitar.length) {
    L.push("## NÃO ANUNCIAR");
    for (const e of evitar.slice(0, 10)) L.push(`- ${e.descricao} — ${e.motivos.join("; ")}${e.substituto ? ` → usar no lugar: ${e.substituto.descricao}` : ""}`);
    L.push("");
  }
  L.push("Plano dos próximos 7 dias: use CHAMARIZ nos dias de maior fluxo, HERO e MARGEM o período todo, GIRO com desconto agressivo e prazo curto, COMPLEMENTAR sempre ao lado dos HERO no PDV e nos posts.");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 3) OFFER SIMULATOR — cenários, nunca promessa.
// ---------------------------------------------------------------------------

function offerSimulator(loja, body = {}) {
  const ref = body.refDate || db.getUltimaDataVenda(loja);
  if (!ref) return { erro: "sem vendas para esta loja" };
  const lid = db.lojaId(loja);

  let produtoId = body.produto_id || null;
  let ean = normalizarEan(body.ean);
  if (!produtoId && ean) {
    const p = db.getProdutoPorEan(ean);
    if (p) produtoId = p.id;
  }
  if (!produtoId && !ean) return { erro: "informe produto_id ou ean" };

  // demanda baseline: venda média diária 30d
  let vmd = body.vmd_baseline;
  let descricao = body.descricao || null;
  let categoria = body.categoria || null;
  if (vmd == null && produtoId) {
    const pr = db.getProdutoPorId(produtoId);
    if (pr) { descricao = descricao || pr.descricao; categoria = categoria || pr.categoria; ean = ean || pr.ean; }
    const jan = db.vendasPorProdutoJanela(loja, addDias(ref, -29), ref);
    const meu = jan.find((r) => normalizarEan(r.barras) === (ean || (pr && pr.ean)));
    vmd = meu ? meu.unidades / 30 : 0;
  }
  vmd = vmd || 0;

  const precoAtual = body.preco_atual != null ? Number(body.preco_atual) :
    (produtoId ? (db.getPrecoEm(lid, produtoId, ref, "normal") || {}).preco : null) ?? null;
  const custoAtual = body.custo_atual != null ? Number(body.custo_atual) :
    (produtoId ? (db.getCustoEm(lid, produtoId, ref) || {}).custo : null) ?? null;
  let estoqueAtual = body.estoque_atual != null ? Number(body.estoque_atual) : null;
  if (estoqueAtual == null && produtoId) {
    const e = db.getEstoqueEm(lid, produtoId, ref);
    if (e) estoqueAtual = e.disponivel != null ? e.disponivel : e.quantidade;
  }
  const precoPromo = body.preco_promocional != null ? Number(body.preco_promocional) : null;
  const duracao = Math.max(1, Number(body.duracao_dias) || CFG_STOCK.campanha_dias_min);

  if (precoAtual == null || precoPromo == null) {
    return {
      erro: "preço atual e preço promocional são obrigatórios (não há preço de tabela cadastrado — informe no corpo)",
      faltando: [precoAtual == null && "preco_atual", precoPromo == null && "preco_promocional"].filter(Boolean),
      contexto: { vmd_baseline: round(vmd, 3), estoque_atual: estoqueAtual, custo_atual: custoAtual },
    };
  }

  const descontoPct = round((1 - precoPromo / precoAtual) * 100, 1);
  const margemAtual = custoAtual != null ? round(precoAtual - custoAtual, 2) : null;
  const margemPromo = custoAtual != null ? round(precoPromo - custoAtual, 2) : null;
  const margemAtualPct = margemAtual != null ? round(margemAtual / precoAtual, 4) : null;
  const margemPromoPct = margemPromo != null ? round(margemPromo / precoPromo, 4) : null;

  // uplift de unidades necessário só para NÃO perder margem bruta total:
  const upliftBreakEven = margemPromo != null && margemPromo > 0 ? round(margemAtual / margemPromo, 3) : null;

  // lift histórico da categoria nos dias de campanha (se houver) — âncora dos cenários
  const liftCat = mpa.liftCampanhaPorCategoria(loja, ref).get(categoria);
  const liftBase = liftCat && liftCat > 1 ? liftCat : 1.15; // fallback conservador declarado
  const cenarioDef = [
    ["CONSERVADOR", Math.max(1.0, 1 + (liftBase - 1) * 0.5)],
    ["PROVAVEL", liftBase],
    ["AGRESSIVO", 1 + (liftBase - 1) * 1.8],
  ];
  const cenarios = cenarioDef.map(([nome, mult]) => {
    const vmdPromo = vmd * mult;
    const unidades = round(vmdPromo * duracao, 0);
    const receita = round(unidades * precoPromo, 2);
    const margemBrutaTotal = margemPromo != null ? round(unidades * margemPromo, 2) : null;
    const margemBrutaSemPromo = margemAtual != null ? round(vmd * duracao * margemAtual, 2) : null;
    const estoqueDepois = estoqueAtual != null ? round(estoqueAtual - unidades, 0) : null;
    const risco = estoqueDepois == null ? "sem_feed_estoque" : estoqueDepois < 0 ? "RUPTURA" : estoqueDepois < vmdPromo * 3 ? "ATENCAO" : "OK";
    return {
      cenario: nome, multiplicador_demanda: round(mult, 2),
      unidades_projetadas: unidades, receita_projetada: receita,
      margem_bruta_total: margemBrutaTotal,
      variacao_margem_vs_sem_promo: margemBrutaTotal != null && margemBrutaSemPromo != null ? round(margemBrutaTotal - margemBrutaSemPromo, 2) : null,
      estoque_depois: estoqueDepois, risco_ruptura: risco,
    };
  });

  return {
    loja, ean: ean || null, produto_id: produtoId, descricao, categoria, refDate: ref,
    entrada: { preco_atual: precoAtual, preco_promocional: precoPromo, custo_atual: custoAtual, estoque_atual: estoqueAtual, vmd_baseline: round(vmd, 3), duracao_dias: duracao },
    desconto_pct: descontoPct,
    margem: { atual: margemAtual, atual_pct: margemAtualPct, promo: margemPromo, promo_pct: margemPromoPct, uplift_break_even: upliftBreakEven },
    ancora_cenarios: { fonte: liftCat ? `lift histórico da categoria "${categoria}" = ${liftCat.toFixed(2)}x` : "sem lift histórico da categoria — usado fallback 1.15x (declarado)", valor: round(liftBase, 3) },
    cenarios,
    dados_ausentes: [custoAtual == null && "custo (margem projetada indisponível)", estoqueAtual == null && "estoque (risco de ruptura indisponível)"].filter(Boolean),
    aviso: "PROJEÇÃO baseada no comportamento histórico. NÃO é promessa de venda. Volume real depende de execução, clima, concorrência e ponto de venda.",
  };
}

module.exports = {
  eficienciaCalendario,
  eficienciaTodasDoCalendario,
  campaignBuilder,
  offerSimulator,
  PAPEIS,
};
