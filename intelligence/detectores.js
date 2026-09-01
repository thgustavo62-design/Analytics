// Fase 5 — detectores determinísticos. Cada um recebe o pacote de contexto (contexto.js) e
// devolve zero ou mais sinais. Regras quantitativas com limiares em config/intelligence.json.
// Sem o feed necessário, o detector não dispara (não inventa sinal) e reporta em `indisponivel`.

const fs = require("fs");
const path = require("path");
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "intelligence.json"), "utf8"));
const D = CFG.detectores;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const key = (...p) => p.map((x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-")).join("|");

// ---------------------------------------------------------------------------

function competitorPriceAttack(ctx) {
  const out = [];
  const cfg = D.COMPETITOR_PRICE_ATTACK;
  for (const [cat, e] of ctx.concorrencia.porCategoria) {
    if (e.abaixo < cfg.min_ofertas_abaixo) continue;
    const sev = Math.min(cfg.severidade_max, cfg.severidade_por_oferta * e.abaixo);
    out.push({
      classe: "AMEACA", tipo: "COMPETITOR_PRICE_ATTACK",
      titulo: `Concorrência atacando preço em ${cat}`,
      resumo: `${e.abaixo} de ${e.ofertas} ofertas coletadas em ${cat} estão abaixo do nosso preço médio.`,
      severidade: sev, confianca: 0.7,
      impacto_estimado: null,
      entidade_tipo: "categoria", entidade_ref: cat, periodo: ctx.concorrencia.periodo,
      dedupe_key: key("competitor_price_attack", cat),
      evidencias: [
        { campo: "ofertas_abaixo_do_nosso", valor: e.abaixo, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo },
        ...e.exemplos.map((x) => ({ campo: "exemplo", valor: `${x.produto} — ${x.concorrente} R$ ${x.promo} vs nosso R$ ${x.nosso}`, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo })),
      ],
    });
  }
  return out;
}

function categoryTrend(ctx) {
  const out = [];
  const dec = D.CATEGORY_DECLINE;
  const gro = D.CATEGORY_GROWTH;
  for (const c of ctx.categoriasTendencia) {
    if (c.var_pct == null || c.receita_30d < dec.receita_min_categoria_30d) continue;
    // impacto mensal ≈ variação da quinzena projetada p/ 30d
    const deltaMes = Math.round((c.receita_14d - c.receita_14d_anterior) * 30 / 14);
    const ev = [
      { campo: "receita_14d", valor: c.receita_14d, fonte: "vendas_transacoes (soma por categoria)", periodo: `últimos 14d até ${ctx.refDate}` },
      { campo: "receita_14d_anterior", valor: c.receita_14d_anterior, fonte: "vendas_transacoes", periodo: `14d anteriores` },
      { campo: "variacao_pct", valor: c.var_pct, fonte: "cálculo", periodo: `${ctx.refDate}` },
    ];
    if (c.var_pct <= -dec.queda_pct_min) {
      out.push({
        classe: "AMEACA", tipo: "CATEGORY_DECLINE",
        titulo: `${c.categoria} caindo ${Math.abs(c.var_pct)}% (2 semanas)`,
        resumo: `Receita de ${c.categoria} nos últimos 14d (R$ ${c.receita_14d}) vs. 14d anteriores (R$ ${c.receita_14d_anterior}).`,
        severidade: clamp01(dec.severidade_base + Math.abs(c.var_pct) / 200),
        confianca: 0.6,
        impacto_estimado: deltaMes < 0 ? -deltaMes : null,
        entidade_tipo: "categoria", entidade_ref: c.categoria, periodo: `${ctx.refDate}`,
        dedupe_key: key("category_decline", c.categoria),
        evidencias: ev,
      });
    } else if (c.var_pct >= gro.alta_pct_min) {
      out.push({
        classe: "OPORTUNIDADE", tipo: "CATEGORY_GROWTH",
        titulo: `${c.categoria} crescendo ${c.var_pct}% (2 semanas)`,
        resumo: `Categoria em alta — reforçar sortimento/comunicação enquanto o vento está a favor.`,
        severidade: clamp01(0.25 + c.var_pct / 400),
        confianca: 0.55,
        impacto_estimado: deltaMes > 0 ? deltaMes : null,
        entidade_tipo: "categoria", entidade_ref: c.categoria, periodo: `${ctx.refDate}`,
        dedupe_key: key("category_growth", c.categoria),
        evidencias: ev,
      });
    }
  }
  return out;
}

function stockRisk(ctx) {
  if (!ctx.feeds.estoque) return [];
  const cfg = D.STOCK_RISK;
  const candidatos = (ctx.analiseProdutos.produtos || [])
    .filter((p) => p.do_not_promote && p.do_not_promote.motivos.some((m) => m.tipo === "RUPTURA"))
    .filter((p) => (p.receita.d30 || 0) >= (cfg.receita_min_30d || 150)) // só o que realmente gira
    .sort((a, b) => (b.receita.d30 || 0) - (a.receita.d30 || 0));
  const out = [];
  const topN = cfg.max_por_deteccao || 12;
  for (const p of candidatos.slice(0, topN)) {
    const rup = p.do_not_promote.motivos.find((m) => m.tipo === "RUPTURA");
    out.push({
      classe: "AMEACA", tipo: "STOCK_RISK",
      titulo: `Risco de ruptura: ${p.descricao}`,
      resumo: `Cobertura de ${p.dias_cobertura}d, R$ ${Math.round(p.receita.d30)} em 30d — repor antes que falte.`,
      severidade: cfg.severidade_base,
      confianca: 0.8,
      impacto_estimado: p.receita.d30 ? Math.round(p.receita.d30) : null,
      entidade_tipo: "produto", entidade_ref: p.ean || p.descricao, periodo: ctx.refDate,
      dedupe_key: key("stock_risk", p.ean || p.descricao),
      evidencias: [rup.evidencia, { campo: "venda_media_diaria_30d", valor: p.venda_media_diaria.d30, fonte: "marketing-product-analytics", periodo: `últimos 30d até ${ctx.refDate}` }],
    });
  }
  // rollup: se sobrou muita coisa, um sinal único com o total e os piores como evidência
  if (candidatos.length > topN) {
    const resto = candidatos.slice(topN);
    out.push({
      classe: "AMEACA", tipo: "STOCK_RISK",
      titulo: `${candidatos.length} produtos com risco de ruptura`,
      resumo: `${topN} listados individualmente; outros ${resto.length} com cobertura curta e giro relevante.`,
      severidade: Math.min(0.85, cfg.severidade_base + candidatos.length / 400),
      confianca: 0.7,
      impacto_estimado: Math.round(candidatos.reduce((s, p) => s + (p.receita.d30 || 0), 0)),
      entidade_tipo: "loja", entidade_ref: ctx.loja, periodo: ctx.refDate,
      dedupe_key: key("stock_risk_rollup", ctx.loja),
      evidencias: resto.slice(0, 10).map((p) => ({ campo: "cobertura", valor: `${p.descricao}: ${p.dias_cobertura}d (R$ ${Math.round(p.receita.d30)}/30d)`, fonte: "marketing-product-analytics", periodo: ctx.refDate })),
    });
  }
  return out;
}

function stagnantStock(ctx) {
  const out = [];
  const parado = (ctx.analiseProdutos.produtos || []).filter((p) => p.do_not_promote && p.do_not_promote.motivos.some((m) => m.tipo === "SEM_GIRO"));
  const semEstoque = !ctx.feeds.estoque;
  const cobertura = (ctx.analiseProdutos.produtos || []).filter((p) => p.cobertura_rotulo === "PARADO" || p.cobertura_infinita);
  const alvo = semEstoque ? parado : cobertura;
  if (!alvo.length) return out;
  const capital = alvo.reduce((s, p) => s + (p.estoque_atual != null && (p.custo_atual || p.preco_praticado) ? p.estoque_atual * (p.custo_atual || p.preco_praticado) : 0), 0);
  out.push({
    classe: "OPORTUNIDADE", tipo: "STAGNANT_STOCK",
    titulo: `${alvo.length} produto(s) parado(s)` + (semEstoque ? " (sem giro 45d+)" : ""),
    resumo: semEstoque
      ? `Sem feed de estoque — lista por "sem venda há 45d+". Candidatos a chamariz/combo/liquidação.`
      : `Cobertura acima do limite de "parado". Capital estimado parado: R$ ${Math.round(capital)}.`,
    severidade: D.STAGNANT_STOCK.severidade_base,
    confianca: semEstoque ? 0.5 : 0.7,
    impacto_estimado: capital ? Math.round(capital) : null,
    entidade_tipo: "loja", entidade_ref: ctx.loja, periodo: ctx.refDate,
    dedupe_key: key("stagnant_stock", ctx.loja),
    evidencias: alvo.slice(0, 8).map((p) => ({ campo: "produto_parado", valor: p.descricao + (p.dias_sem_venda != null ? ` (${p.dias_sem_venda}d s/ venda)` : ""), fonte: "marketing-product-analytics", periodo: ctx.refDate })),
  });
  return out;
}

function campaignPerformance(ctx) {
  const out = [];
  for (const e of ctx.eficienciaCampanhas || []) {
    if (e.erro || !e.amostra || !e.amostra.suficiente) continue;
    const lift = e.metricas.DEMAND_LIFT_receita;
    if (lift == null) continue;
    if (lift < D.CAMPAIGN_UNDERPERFORMANCE.lift_min_aceitavel) {
      out.push({
        classe: "AMEACA", tipo: "CAMPAIGN_UNDERPERFORMANCE",
        titulo: `Campanha "${e.campanha}" rendendo pouco`,
        resumo: `DEMAND_LIFT de receita = ${lift}× nos dias de campanha vs. dias normais (veredito ${e.veredito}).`,
        severidade: clamp01(D.CAMPAIGN_UNDERPERFORMANCE.severidade_base + (1 - Math.min(1, lift)) * 0.4),
        confianca: 0.6,
        impacto_estimado: null,
        entidade_tipo: "campanha", entidade_ref: e.campanha, periodo: `${e.janela.inicio}..${e.janela.fim}`,
        dedupe_key: key("campaign_under", e.campanha),
        evidencias: [e.evidencia, { campo: "veredito", valor: e.veredito, fonte: "campanhas.eficienciaCalendario", periodo: `${e.janela.inicio}..${e.janela.fim}` }],
      });
    } else if (lift >= D.CAMPAIGN_OVERPERFORMANCE.lift_excelente) {
      out.push({
        classe: "OPORTUNIDADE", tipo: "CAMPAIGN_OVERPERFORMANCE",
        titulo: `Campanha "${e.campanha}" voando`,
        resumo: `DEMAND_LIFT = ${lift}× — vale ampliar sortimento/verba e testar mais dias.`,
        severidade: 0.3, confianca: 0.6, impacto_estimado: null,
        entidade_tipo: "campanha", entidade_ref: e.campanha, periodo: `${e.janela.inicio}..${e.janela.fim}`,
        dedupe_key: key("campaign_over", e.campanha),
        evidencias: [e.evidencia],
      });
    }
  }
  return out;
}

function demandAnomaly(ctx) {
  const out = [];
  const cfg = D.DEMAND_ANOMALY;
  for (const p of ctx.analiseProdutos.produtos || []) {
    if (p.tendencia.pct == null || p.unidades[30] < cfg.unid_30d_min) continue;
    if (Math.abs(p.tendencia.pct) < cfg.tendencia_pct_abs_min) continue;
    const subindo = p.tendencia.pct > 0;
    out.push({
      classe: subindo ? "OPORTUNIDADE" : "SINAL",
      tipo: "DEMAND_ANOMALY",
      titulo: `${p.descricao}: demanda ${subindo ? "disparou" : "despencou"} ${p.tendencia.pct}%`,
      resumo: `${p.unidades[30]} un nos últimos 30d; tendência ${p.tendencia.rotulo} (14d vs 14d).`,
      severidade: clamp01(cfg.severidade_base + Math.abs(p.tendencia.pct) / 400),
      confianca: 0.55,
      impacto_estimado: null,
      entidade_tipo: "produto", entidade_ref: p.ean || p.descricao, periodo: ctx.refDate,
      dedupe_key: key("demand_anomaly", p.ean || p.descricao, subindo ? "up" : "down"),
      evidencias: [
        { campo: "tendencia_pct", valor: p.tendencia.pct, fonte: "marketing-product-analytics (14d x 14d)", periodo: `${ctx.refDate}` },
        { campo: "unidades_30d", valor: p.unidades[30], fonte: "vendas_transacoes", periodo: `últimos 30d até ${ctx.refDate}` },
      ],
    });
  }
  // limita ao top 8 por severidade para não afogar o painel
  return out.sort((a, b) => b.severidade - a.severidade).slice(0, 8);
}

function crossSellOpportunity(ctx) {
  const out = [];
  const cfg = D.CROSS_SELL_OPPORTUNITY;
  const porId = new Map((ctx.analiseProdutos.produtos || []).map((p) => [p.produto_id, p]));
  for (const par of ctx.cesta.pares || []) {
    if (par.lift < cfg.lift_min) continue;
    const a = porId.get(par.produto_a);
    const b = porId.get(par.produto_b);
    if (!a || !b) continue;
    const hero = a.classe === "HERO" ? a : b.classe === "HERO" ? b : null;
    const outro = hero === a ? b : hero === b ? a : null;
    if (!hero || !outro) continue;
    out.push({
      classe: "OPORTUNIDADE", tipo: "CROSS_SELL_OPPORTUNITY",
      titulo: `Combo natural: ${par.desc_a} + ${par.desc_b}`,
      resumo: `Compram juntos ${par.lift}× mais que o acaso. Um é HERO (${hero.descricao}); o outro (${outro.descricao}) não está sendo puxado.`,
      severidade: 0.25,
      confianca: clamp01(0.4 + (par.lift - cfg.lift_min) / 10),
      impacto_estimado: null,
      entidade_tipo: "produto", entidade_ref: (outro.ean || outro.descricao),
      periodo: ctx.cesta.janela ? `${ctx.cesta.janela.inicio}..${ctx.cesta.janela.fim}` : ctx.refDate,
      dedupe_key: key("cross_sell", par.produto_a, par.produto_b),
      evidencias: [
        { campo: "lift", valor: par.lift, fonte: "cesta_pares", periodo: ctx.cesta.janela ? `${ctx.cesta.janela.inicio}..${ctx.cesta.janela.fim}` : "" },
        { campo: "confidence", valor: par.confidence, fonte: "cesta_pares", periodo: "" },
      ],
    });
  }
  return out.slice(0, 6);
}

function marketingOpportunity(ctx) {
  const out = [];
  const cfg = D.MARKETING_OPPORTUNITY;
  const emCampanha = new Set();
  for (const c of ctx.lojaCfg.campanhas || []) for (const cat of c.categorias || []) emCampanha.add(cat);
  for (const p of ctx.analiseProdutos.produtos || []) {
    if (p.opportunity.score < cfg.opportunity_min || p.opportunity.confianca < cfg.confianca_min) continue;
    if (p.classe !== "OPORTUNIDADE" && p.classe !== "HERO") continue;
    if (emCampanha.has(p.categoria)) continue; // já tem canal
    out.push({
      classe: "OPORTUNIDADE", tipo: "MARKETING_OPPORTUNITY",
      titulo: `Anunciar: ${p.descricao}`,
      resumo: `Opportunity ${p.opportunity.score} (${p.opportunity.rotulo}), classe ${p.classe}, categoria "${p.categoria}" sem campanha fixa.`,
      severidade: 0.2,
      confianca: p.opportunity.confianca,
      impacto_estimado: null,
      entidade_tipo: "produto", entidade_ref: p.ean || p.descricao, periodo: ctx.refDate,
      dedupe_key: key("mkt_opp", p.ean || p.descricao),
      evidencias: [
        { campo: "opportunity.score", valor: p.opportunity.score, fonte: "marketing-product-analytics", periodo: ctx.refDate },
        { campo: "tendencia", valor: `${p.tendencia.rotulo} ${p.tendencia.pct ?? ""}`, fonte: "marketing-product-analytics", periodo: ctx.refDate },
      ],
    });
  }
  return out.sort((a, b) => b.confianca - a.confianca).slice(0, 6);
}

function creativeFatigue(ctx) {
  const cfg = D.CREATIVE_FATIGUE;
  if (!ctx.instagram.length) return [];
  const out = [];
  // pega o período mais recente
  const ult = ctx.instagram.reduce((m, x) => (x.periodo > m ? x.periodo : m), ctx.instagram[0].periodo);
  const quedas = ctx.instagram.filter((x) => x.periodo === ult && cfg.metricas.includes(x.metrica) && x.delta_pct != null && x.delta_pct <= -cfg.queda_pct_min);
  if (quedas.length >= 2) {
    out.push({
      classe: "SINAL", tipo: "CREATIVE_FATIGUE",
      titulo: `Instagram perdendo tração (${ult})`,
      resumo: `${quedas.map((q) => `${q.rotulo} ${q.delta_pct}%`).join(", ")} — hora de renovar criativos/formatos.`,
      severidade: 0.35, confianca: 0.5, impacto_estimado: null,
      entidade_tipo: "canal", entidade_ref: "instagram", periodo: ult,
      dedupe_key: key("creative_fatigue", ult),
      evidencias: quedas.map((q) => ({ campo: q.metrica, valor: `${q.delta_pct}%`, fonte: "instagram_metricas", periodo: ult })),
    });
  }
  return out;
}

function contradictions(ctx, sinaisAteAqui) {
  const out = [];
  // 1) campanha OVERperformance numa categoria que está em DECLINE
  const overs = sinaisAteAqui.filter((s) => s.tipo === "CAMPAIGN_OVERPERFORMANCE");
  const declines = new Set(sinaisAteAqui.filter((s) => s.tipo === "CATEGORY_DECLINE").map((s) => s.entidade_ref));
  for (const o of overs) {
    const camp = (ctx.lojaCfg.campanhas || []).find((c) => c.nome === o.entidade_ref);
    const cats = (camp && camp.categorias) || [];
    const bate = cats.filter((c) => declines.has(c));
    if (bate.length) {
      out.push({
        classe: "CONTRADICAO", tipo: "CONTRADICTION",
        titulo: `Contradição: "${o.entidade_ref}" vai bem mas ${bate.join("/")} cai`,
        resumo: `A campanha performa acima da média enquanto a receita da(s) categoria(s) dela cai no mês — o lift pode estar mascarando perda de base.`,
        severidade: D.CONTRADICTION.severidade_base, confianca: 0.5, impacto_estimado: null,
        entidade_tipo: "campanha", entidade_ref: o.entidade_ref, periodo: ctx.refDate,
        dedupe_key: key("contradiction", "camp-vs-cat", o.entidade_ref),
        evidencias: [
          { campo: "campanha_lift", valor: "acima do excelente", fonte: "CAMPAIGN_OVERPERFORMANCE", periodo: ctx.refDate },
          { campo: "categorias_em_queda", valor: bate.join(", "), fonte: "CATEGORY_DECLINE", periodo: ctx.refDate },
        ],
      });
    }
  }
  // 2) produto na lista do-not-promote mas com MARKETING_OPPORTUNITY (não deve acontecer; se
  //    acontecer, é bug de dado — vira contradição para revisão)
  const dnp = new Set((ctx.analiseProdutos.produtos || []).filter((p) => p.do_not_promote).map((p) => p.ean || p.descricao));
  for (const s of sinaisAteAqui.filter((x) => x.tipo === "MARKETING_OPPORTUNITY")) {
    if (dnp.has(s.entidade_ref)) {
      out.push({
        classe: "CONTRADICAO", tipo: "CONTRADICTION",
        titulo: `Contradição: ${s.entidade_ref} recomendado e bloqueado ao mesmo tempo`,
        resumo: `Revisar cadastro/feed: o mesmo produto aparece como oportunidade e como "não anunciar".`,
        severidade: 0.5, confianca: 0.6, impacto_estimado: null,
        entidade_tipo: "produto", entidade_ref: s.entidade_ref, periodo: ctx.refDate,
        dedupe_key: key("contradiction", "opp-vs-dnp", s.entidade_ref),
        evidencias: [{ campo: "conflito", valor: "MARKETING_OPPORTUNITY ∩ do-not-promote", fonte: "detectores", periodo: ctx.refDate }],
      });
    }
  }
  return out;
}

// ordem importa: contradições veem os demais sinais.
const DETECTORES_BASE = [
  competitorPriceAttack, categoryTrend, stockRisk, stagnantStock,
  campaignPerformance, demandAnomaly, crossSellOpportunity, marketingOpportunity, creativeFatigue,
];

function rodarTodos(ctx) {
  const sinais = [];
  const indisponivel = [];
  if (!ctx.feeds.estoque) indisponivel.push("STOCK_RISK parcial e days-of-cover reais (sem feed de estoque)");
  if (!ctx.feeds.custo) indisponivel.push("impacto de margem nos sinais (sem feed de custo)");
  if (!ctx.instagram.length) indisponivel.push("CREATIVE_FATIGUE (sem métricas de Instagram)");
  if (!ctx.concorrencia.totalOfertas) indisponivel.push("COMPETITOR_PRICE_ATTACK (sem coleta de concorrência)");

  for (const fn of DETECTORES_BASE) {
    try {
      for (const s of fn(ctx) || []) sinais.push(s);
    } catch (e) {
      indisponivel.push(`${fn.name}: erro (${e.message})`);
    }
  }
  for (const s of contradictions(ctx, sinais) || []) sinais.push(s);
  return { sinais, indisponivel };
}

module.exports = { rodarTodos, DETECTORES_BASE };
