// Fase 6 — Investigação ("Por quê?"). Dado um sinal (ou uma pergunta livre), levanta
// hipóteses de causa e as confronta com os agregados que já temos. Determinístico: cada
// hipótese vira "suportada / refutada / inconclusiva" por uma checagem numérica, com a
// evidência anexada (lineage). Nenhuma IA.

const db = require("../db");
const { montarContexto } = require("./contexto");

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function catDoContexto(ctx, nome) {
  const alvo = norm(nome);
  return (ctx.categoriasTendencia || []).find((c) => norm(c.categoria) === alvo || norm(c.categoria).includes(alvo));
}

function h(texto, veredito, confianca, evidencias) {
  return { texto, veredito, confianca: Math.round(confianca * 100) / 100, evidencias: evidencias || [] };
}

// ---- bibliotecas de hipóteses por assunto ----

function hipotesesCategoria(ctx, categoria) {
  const H = [];
  const c = catDoContexto(ctx, categoria);
  const cat = c ? c.categoria : categoria;

  // H: concorrência atacou preço
  const conc = ctx.concorrencia.porCategoria.get(cat);
  if (conc && conc.abaixo >= 3) {
    H.push(h(
      `Concorrência atacou preço em ${cat} (${conc.abaixo} ofertas abaixo do nosso).`,
      "suportada", 0.7,
      [{ campo: "ofertas_abaixo", valor: conc.abaixo, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo },
       ...conc.exemplos.slice(0, 3).map((x) => ({ campo: "exemplo", valor: `${x.produto} ${x.concorrente} R$ ${x.promo}`, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo }))]
    ));
  } else if (ctx.concorrencia.totalOfertas) {
    H.push(h(`Concorrência atacou preço em ${cat}.`, "refutada", 0.55,
      [{ campo: "ofertas_abaixo", valor: conc ? conc.abaixo : 0, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo }]));
  } else {
    H.push(h(`Concorrência atacou preço em ${cat}.`, "inconclusiva", 0.2,
      [{ campo: "coleta_concorrencia", valor: "ausente no período", fonte: "concorrencia_ofertas", periodo: ctx.refDate }]));
  }

  // H: ruptura de estoque nos itens da categoria
  const itens = (ctx.analiseProdutos.produtos || []).filter((p) => p.categoria === cat);
  if (ctx.feeds.estoque) {
    const rup = itens.filter((p) => ["RUPTURA", "ATENCAO"].includes(p.cobertura_rotulo));
    H.push(h(
      `Falta de estoque nos itens de ${cat} derrubou a venda.`,
      rup.length >= Math.max(2, itens.length * 0.15) ? "suportada" : "refutada",
      rup.length ? 0.6 : 0.5,
      rup.slice(0, 5).map((p) => ({ campo: "cobertura", valor: `${p.descricao}: ${p.dias_cobertura}d (${p.cobertura_rotulo})`, fonte: "marketing-product-analytics", periodo: ctx.refDate }))
    ));
  } else {
    H.push(h(`Falta de estoque nos itens de ${cat} derrubou a venda.`, "inconclusiva", 0.2,
      [{ campo: "feed_estoque", valor: "ausente", fonte: "produto_estoque", periodo: ctx.refDate }]));
  }

  // H: é queda geral da loja, não só da categoria
  const fh = ctx.historicoFaturamento.filter((x) => !x.parcial);
  if (fh.length >= 2) {
    const varLoja = fh[1].faturamento > 0 ? ((fh[0].faturamento - fh[1].faturamento) / fh[1].faturamento) * 100 : null;
    const varCat = c ? c.var_pct : null;
    const geral = varLoja != null && varCat != null && varLoja <= -8 && Math.abs(varLoja - varCat) < 10;
    H.push(h(
      `A queda é da loja inteira, não específica de ${cat}.`,
      geral ? "suportada" : "refutada",
      0.5,
      [{ campo: "var_faturamento_loja_pct", valor: varLoja == null ? "s/ base" : Math.round(varLoja * 10) / 10, fonte: "periodos (faturamento mês a mês)", periodo: `${fh[1].periodo}→${fh[0].periodo}` },
       { campo: "var_categoria_pct", valor: varCat, fonte: "vendas_transacoes", periodo: `30d x 30d até ${ctx.refDate}` }]
    ));
  }

  // H: perdeu tração porque saiu do calendário de campanha
  const temCamp = (ctx.lojaCfg.campanhas || []).some((cp) => (cp.categorias || []).includes(cat));
  H.push(h(
    `${cat} depende de campanha e o efeito do calendário oscilou no período.`,
    temCamp ? "inconclusiva" : "refutada",
    temCamp ? 0.35 : 0.5,
    [{ campo: "categoria_no_calendario", valor: temCamp ? "sim" : "não", fonte: "config/lojas.json", periodo: ctx.refDate }]
  ));

  return H;
}

function hipotesesCampanha(ctx, nomeCampanha) {
  const H = [];
  const ef = (ctx.eficienciaCampanhas || []).find((e) => norm(e.campanha).includes(norm(nomeCampanha))) || (ctx.eficienciaCampanhas || [])[0];
  if (!ef || ef.erro) return [h("Sem dados suficientes da campanha.", "inconclusiva", 0.1, [])];
  const cats = ef.categorias || [];

  // H: efeito é só dia-da-semana, não a campanha
  H.push(h(
    `O "lift" é efeito do dia da semana, não da campanha em si.`,
    ef.metricas.DEMAND_LIFT_receita != null && ef.metricas.DEMAND_LIFT_receita < 1.15 ? "suportada" : "refutada",
    0.45,
    [ef.evidencia]
  ));

  // H: ruptura nos itens da campanha
  if (ctx.feeds.estoque) {
    const itens = (ctx.analiseProdutos.produtos || []).filter((p) => cats.includes(p.categoria));
    const rup = itens.filter((p) => ["RUPTURA", "ATENCAO"].includes(p.cobertura_rotulo));
    H.push(h(`Faltou estoque dos itens da campanha nos dias certos.`, rup.length ? "suportada" : "refutada", rup.length ? 0.55 : 0.45,
      rup.slice(0, 5).map((p) => ({ campo: "cobertura", valor: `${p.descricao}: ${p.cobertura_rotulo}`, fonte: "marketing-product-analytics", periodo: ctx.refDate }))));
  }

  // H: concorrência bateu na(s) categoria(s) da campanha
  let abaixo = 0;
  for (const cat of cats) abaixo += (ctx.concorrencia.porCategoria.get(cat)?.abaixo || 0);
  H.push(h(`Concorrência ofereceu mais barato nas categorias da campanha.`, abaixo >= 3 ? "suportada" : ctx.concorrencia.totalOfertas ? "refutada" : "inconclusiva", abaixo >= 3 ? 0.6 : 0.35,
    [{ campo: "ofertas_abaixo_nas_categorias", valor: abaixo, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo }]));

  // H: a própria categoria está em queda estrutural
  const decl = cats.map((cat) => catDoContexto(ctx, cat)).filter((c) => c && c.var_pct != null && c.var_pct <= -12);
  H.push(h(`A(s) categoria(s) da campanha está(ão) em queda estrutural (não é a campanha).`, decl.length ? "suportada" : "refutada", decl.length ? 0.55 : 0.4,
    decl.map((c) => ({ campo: "var_categoria_pct", valor: `${c.categoria}: ${c.var_pct}%`, fonte: "vendas_transacoes", periodo: `30d x 30d até ${ctx.refDate}` }))));

  return H;
}

function hipotesesProduto(ctx, ref) {
  const alvo = norm(ref);
  const p = (ctx.analiseProdutos.produtos || []).find((x) => x.ean === ref || norm(x.descricao).includes(alvo));
  if (!p) return [h("Produto não encontrado nas vendas do período.", "inconclusiva", 0.1, [])];
  const H = [];
  H.push(h(`A demanda mudou de verdade (tendência ${p.tendencia.rotulo}).`,
    p.tendencia.pct != null && Math.abs(p.tendencia.pct) >= 25 ? "suportada" : "refutada", 0.55,
    [{ campo: "tendencia_pct", valor: p.tendencia.pct, fonte: "marketing-product-analytics", periodo: ctx.refDate },
     { campo: "unidades_30d", valor: p.unidades[30], fonte: "vendas_transacoes", periodo: `30d até ${ctx.refDate}` }]));
  if (ctx.feeds.estoque) {
    H.push(h(`Ruptura de estoque limitou a venda.`, ["RUPTURA", "ATENCAO"].includes(p.cobertura_rotulo) ? "suportada" : "refutada", 0.6,
      [{ campo: "cobertura", valor: `${p.dias_cobertura}d (${p.cobertura_rotulo})`, fonte: "marketing-product-analytics", periodo: ctx.refDate }]));
  }
  const conc = ctx.concorrencia.porCategoria.get(p.categoria);
  H.push(h(`Concorrência puxou o cliente com preço na categoria ${p.categoria}.`,
    conc && conc.abaixo >= 3 ? "suportada" : ctx.concorrencia.totalOfertas ? "refutada" : "inconclusiva",
    conc && conc.abaixo >= 3 ? 0.55 : 0.3,
    [{ campo: "ofertas_abaixo", valor: conc ? conc.abaixo : 0, fonte: "concorrencia_ofertas", periodo: ctx.concorrencia.periodo }]));
  return H;
}

// ---- roteamento da pergunta ----

const RE_CAT = /(fralda|leite|limpeza|higiene|perfumaria|medicament|suplement|dermocosm|infantil|gen[eé]ric)/i;

function investigar(loja, { pergunta, sinalId } = {}) {
  const ctx = montarContexto(loja);
  let assunto = null;
  let hips = [];
  let q = pergunta || "";

  if (sinalId) {
    const s = db.getSinal(sinalId);
    if (!s) return { erro: "sinal não encontrado" };
    q = q || `Por que: ${s.titulo}?`;
    if (s.entidade_tipo === "categoria") { assunto = { tipo: "categoria", ref: s.entidade_ref }; hips = hipotesesCategoria(ctx, s.entidade_ref); }
    else if (s.entidade_tipo === "campanha") { assunto = { tipo: "campanha", ref: s.entidade_ref }; hips = hipotesesCampanha(ctx, s.entidade_ref); }
    else if (s.entidade_tipo === "produto") { assunto = { tipo: "produto", ref: s.entidade_ref }; hips = hipotesesProduto(ctx, s.entidade_ref); }
    else { assunto = { tipo: "loja", ref: loja }; hips = hipotesesCategoria(ctx, (ctx.categoriasTendencia[0] || {}).categoria || ""); }
  } else {
    const mCamp = /campanha\s+["“]?([^"”?]+)/i.exec(q);
    const mCat = RE_CAT.exec(q);
    if (mCamp) { assunto = { tipo: "campanha", ref: mCamp[1].trim() }; hips = hipotesesCampanha(ctx, mCamp[1].trim()); }
    else if (mCat) {
      const nomeCat = { fralda: "Fraldas", leite: "Leite Infantil", limpeza: "Limpeza", higiene: "Higiene", perfumaria: "Perfumaria" }[mCat[1].toLowerCase().slice(0, 6)] || mCat[0];
      assunto = { tipo: "categoria", ref: nomeCat };
      hips = hipotesesCategoria(ctx, nomeCat);
    } else {
      assunto = { tipo: "loja", ref: loja };
      const pior = [...(ctx.categoriasTendencia || [])].filter((c) => c.var_pct != null).sort((a, b) => a.var_pct - b.var_pct)[0];
      hips = pior ? hipotesesCategoria(ctx, pior.categoria) : [];
    }
  }

  // conclusão: a hipótese suportada de maior confiança
  const suportadas = hips.filter((x) => x.veredito === "suportada").sort((a, b) => b.confianca - a.confianca);
  const conclusao = suportadas.length
    ? `Causa mais provável: ${suportadas[0].texto}` + (suportadas[1] ? ` Também pesa: ${suportadas[1].texto}` : "")
    : "Sem causa isolada com evidência suficiente — investigar manualmente (ver hipóteses inconclusivas).";
  const confianca = suportadas.length ? suportadas[0].confianca : 0.2;

  return { loja, pergunta: q, assunto, hipoteses: hips, conclusao, confianca, refDate: ctx.refDate, sinalId: sinalId || null };
}

// grava uma investigação (pergunta + hipóteses) no banco
function investigarEGravar(loja, params) {
  const r = investigar(loja, params);
  if (r.erro) return r;
  const id = db.criarInvestigacao(loja, { pergunta: r.pergunta, sinal_id: r.sinalId });
  for (const hp of r.hipoteses) db.addHipotese(id, hp);
  db.concluirInvestigacao(id, { conclusao: r.conclusao, confianca: r.confianca });
  return { ...db.getInvestigacao(id), assunto: r.assunto };
}

module.exports = { investigar, investigarEGravar };
