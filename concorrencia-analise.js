// Aba Concorrentes — comparação automática e análise.
//
// Cruza as ofertas de concorrente (concorrencia_ofertas, vindas da planilha na inbox) com a
// nossa inteligência de produto (Fase 2: quanto vendemos, classe, margem, cobertura) e com o
// momentum de categoria. Tudo determinístico. Saída: panorama + por concorrente + por
// categoria + "onde reagir" (priorizado) + resumo + ações.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const mpa = require("./marketing-product-analytics");
const { montarContexto } = require("./intelligence/contexto");
const { normalizarEan } = require("./catalogo");
const { bestMatch } = require("./match");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const round = (n, d) => (n == null ? null : Math.round((n + Number.EPSILON) * Math.pow(10, d ?? 2)) / Math.pow(10, d ?? 2));

// acha o período mais recente que tem coleta de concorrência
function periodoComColeta(loja) {
  for (const p of db.listPeriodos(loja).filter((x) => x.temVendas)) {
    const per = db.findPeriodo(loja, p.ano, p.mes);
    if (per && db.getConcorrencia(per.id).length) return { per, periodo: p.periodo };
  }
  return null;
}

function analisarConcorrencia(loja) {
  const alvo = periodoComColeta(loja);
  if (!alvo) {
    const cfg = LOJAS_CFG[loja] || {};
    return {
      loja, pendente: true,
      concorrentes: (cfg.concorrentes || []).map((c) => ({ concorrente: c.nome, handle: c.handle || null, nota: c.nota || null, temColeta: false })),
      nota: "Nenhuma coleta de concorrente ainda. Jogue um xlsx com Concorrente + Produto + Preço na pasta inbox (nome com 'concorrente'/'coleta' ou o nome do concorrente).",
    };
  }
  const { per, periodo } = alvo;
  const ofertas = db.getConcorrencia(per.id);
  const cfg = LOJAS_CFG[loja] || {};
  const ctx = montarContexto(loja);
  const nossosProdutos = ctx.analiseProdutos.produtos || [];
  const nossos = new Map();
  const candFuzzy = [];
  for (const p of nossosProdutos) {
    if (p.ean) nossos.set(p.ean, p);
    nossos.set(norm(p.descricao), p);
    candFuzzy.push({ name: p.descricao, _p: p });
  }
  const acharNosso = (o) => {
    let p =
      (o.produto_casado && nossos.get(norm(o.produto_casado))) ||
      (normalizarEan(o.produto) && nossos.get(normalizarEan(o.produto))) ||
      nossos.get(norm(o.produto)) || null;
    if (!p) {
      const m = bestMatch(o.produto_casado || o.produto, candFuzzy, { minScore: 0.45, minOverlap: 2, brand: o.marca });
      if (m) p = m.match._p;
    }
    return p;
  };
  const catTendencia = new Map((ctx.categoriasTendencia || []).map((c) => [c.categoria, c]));

  // ---- panorama ----
  const comparaveis = ofertas.filter((o) => o.abaixo_do_nosso != null);
  const abaixo = ofertas.filter((o) => !!o.abaixo_do_nosso);
  const descs = ofertas
    .filter((o) => o.preco_normal > 0 && o.preco_promo > 0 && o.preco_promo < o.preco_normal)
    .map((o) => (1 - o.preco_promo / o.preco_normal) * 100);
  const descsVsNosso = abaixo
    .filter((o) => o.nosso_preco_medio > 0 && o.preco_promo > 0)
    .map((o) => (1 - o.preco_promo / o.nosso_preco_medio) * 100);
  const panorama = {
    periodo,
    coleta_em: ofertas[0] && ofertas[0].validade ? null : null,
    total_ofertas: ofertas.length,
    comparaveis: comparaveis.length,
    abaixo_do_nosso: abaixo.length,
    desconto_medio_pct: descs.length ? Math.round(descs.reduce((s, x) => s + x, 0) / descs.length) : null,
    desconto_medio_vs_nosso_pct: descsVsNosso.length ? Math.round(descsVsNosso.reduce((s, x) => s + x, 0) / descsVsNosso.length) : null,
    melhor_preco: (() => { const v = ofertas.map((o) => o.preco_promo).filter((x) => x > 0); return v.length ? Math.min(...v) : null; })(),
  };

  // ---- por concorrente (começa por todos os do config) ----
  const porConc = new Map();
  const chave = (nome) => norm(nome);
  for (const c of cfg.concorrentes || []) {
    porConc.set(chave(c.nome), { concorrente: c.nome, handle: c.handle || null, nota: c.nota || null, temColeta: false, ofertas: 0, comparaveis: 0, abaixo: 0, confianca: { Alta: 0, "Média": 0, Baixa: 0 }, categorias: {}, exemplos: [] });
  }
  for (const o of ofertas) {
    const k = chave(o.concorrente);
    if (!porConc.has(k)) porConc.set(k, { concorrente: o.concorrente || "(não informado)", handle: null, nota: null, temColeta: false, ofertas: 0, comparaveis: 0, abaixo: 0, confianca: { Alta: 0, "Média": 0, Baixa: 0 }, categorias: {}, exemplos: [] });
    const e = porConc.get(k);
    e.temColeta = true;
    e.ofertas++;
    if (o.abaixo_do_nosso != null) { e.comparaveis++; if (o.abaixo_do_nosso) e.abaixo++; }
    const nc = norm(o.nivel_confianca);
    if (/alta/.test(nc)) e.confianca.Alta++;
    else if (/med/.test(nc)) e.confianca["Média"]++;
    else if (/baix/.test(nc)) e.confianca.Baixa++;
    if (o.categoria) e.categorias[o.categoria] = (e.categorias[o.categoria] || 0) + (o.abaixo_do_nosso ? 1 : 0);
    if (o.abaixo_do_nosso && e.exemplos.length < 6) {
      const diff = o.nosso_preco_medio > 0 ? Math.round((1 - o.preco_promo / o.nosso_preco_medio) * 100) : null;
      e.exemplos.push({ produto: o.produto, categoria: o.categoria, preco_deles: o.preco_promo, nosso: o.nosso_preco_medio, diff_pct: diff, confianca: o.nivel_confianca });
    }
  }
  const concorrentes = [...porConc.values()]
    .map((e) => ({ ...e, categorias_atacadas: Object.entries(e.categorias).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([c]) => c) }))
    .sort((a, b) => Number(b.temColeta) - Number(a.temColeta) || b.abaixo - a.abaixo || b.ofertas - a.ofertas);

  // ---- por categoria ----
  const porCat = new Map();
  for (const o of ofertas) {
    if (!o.categoria) continue;
    const e = porCat.get(o.categoria) || { categoria: o.categoria, ofertas: 0, abaixo: 0, descs: [] };
    e.ofertas++;
    if (o.abaixo_do_nosso) {
      e.abaixo++;
      if (o.nosso_preco_medio > 0 && o.preco_promo > 0) e.descs.push((1 - o.preco_promo / o.nosso_preco_medio) * 100);
    }
    porCat.set(o.categoria, e);
  }
  const categorias = [...porCat.values()]
    .map((e) => {
      const t = catTendencia.get(e.categoria);
      return {
        categoria: e.categoria, ofertas: e.ofertas, abaixo: e.abaixo,
        desconto_medio_vs_nosso_pct: e.descs.length ? Math.round(e.descs.reduce((s, x) => s + x, 0) / e.descs.length) : null,
        nossa_tendencia_pct: t ? t.var_pct : null,
        nossa_receita_30d: t ? t.receita_30d : null,
        pressao: e.abaixo >= 3 ? "ALTA" : e.abaixo >= 1 ? "MÉDIA" : "BAIXA",
      };
    })
    .sort((a, b) => b.abaixo - a.abaixo || b.ofertas - a.ofertas);

  // ---- onde reagir (priorizado): cruza cada oferta abaixo com o produto nosso ----
  const reagir = [];
  for (const o of abaixo) {
    const p = acharNosso(o);
    const nossoPreco = o.nosso_preco_medio || (p && (p.preco_atual || p.preco_praticado)) || null;
    const diffPct = nossoPreco && o.preco_promo ? round((1 - o.preco_promo / nossoPreco) * 100, 1) : null;
    const vendemos = !!(p || o.nosso_preco_medio > 0); // preço médio nosso => já vendemos o item
    const un30 = p ? p.unidades[30] : null;
    const rec30 = p ? p.receita.d30 : (o.nosso_preco_medio > 0 && !p ? null : null);
    const margem = p ? p.margem_pct : null;
    // score: relevância (vendemos e quanto) 0.5 + quão abaixo 0.3 + acionável (margem) 0.2
    const volN = rec30 != null ? Math.min(1, rec30 / 2000) : vendemos ? 0.4 : 0.1;
    const gapN = diffPct != null ? Math.min(1, Math.max(0, diffPct) / 30) : 0.3;
    const acionavel = margem == null ? 0.5 : margem >= 0.1 ? 1 : margem > 0 ? 0.5 : 0.1;
    const score = round(100 * (0.5 * volN + 0.3 * gapN + 0.2 * acionavel), 0);
    let veredito;
    if (!vendemos) veredito = "a gente quase não vende — pode ignorar";
    else if (margem == null) veredito = "avaliar (sem custo cadastrado)";
    else if (margem >= 0.08) veredito = "dá para cobrir com margem";
    else if (margem > 0) veredito = "cobrir aperta a margem";
    else veredito = "não cobrir — margem insuficiente";
    reagir.push({
      produto: o.produto, produto_casado: o.produto_casado || null, categoria: o.categoria,
      concorrente: o.concorrente, confianca: o.nivel_confianca,
      preco_deles: o.preco_promo, nosso_preco: round(nossoPreco, 2), diff_pct: diffPct,
      vendemos, nossas_unid_30d: un30, nossa_receita_30d: round(rec30, 2),
      nossa_classe: p ? p.classe : null, nossa_margem_pct: margem, nossa_cobertura: p ? p.cobertura_rotulo : null,
      score, veredito,
    });
  }
  reagir.sort((a, b) => b.score - a.score);

  // ---- resumo + ações (determinístico) ----
  const maisAgressivo = concorrentes.filter((c) => c.temColeta).sort((a, b) => b.abaixo - a.abaixo)[0];
  const catsPressao = categorias.filter((c) => c.pressao !== "BAIXA").map((c) => c.categoria);
  const topReagir = reagir.filter((r) => r.score >= 45).slice(0, 5);
  const resumo = [
    maisAgressivo && maisAgressivo.abaixo
      ? `Concorrente mais agressivo: ${maisAgressivo.concorrente} — ${maisAgressivo.abaixo} de ${maisAgressivo.comparaveis} ofertas comparáveis abaixo do nosso preço${panorama.desconto_medio_vs_nosso_pct ? `, ${panorama.desconto_medio_vs_nosso_pct}% mais barato em média` : ""}.`
      : "Nenhum concorrente sistematicamente abaixo do nosso preço nesta coleta.",
    catsPressao.length ? `Categorias sob pressão: ${catsPressao.join(", ")}.` : "Sem categoria sob pressão relevante.",
    topReagir.length
      ? `Onde dói mais: ${topReagir[0].produto}${topReagir[0].nossa_receita_30d ? ` (vendemos R$ ${topReagir[0].nossa_receita_30d}/mês` + (topReagir[0].diff_pct != null ? `, eles ${topReagir[0].diff_pct}% abaixo)` : ")") : ""}.`
      : "Nenhum produto de peso com concorrente abaixo — prioridade baixa.",
  ];
  const acoes = [];
  if (topReagir.length) acoes.push(`Cobrir preço / comunicar "melhor preço" em: ${topReagir.map((r) => r.produto).slice(0, 4).join("; ")}.`);
  if (catsPressao.length) acoes.push(`Montar campanha de defesa nas categorias ${catsPressao.slice(0, 3).join(", ")} (ver Intelligence → Recomendações).`);
  const baixaConf = ofertas.filter((o) => /baix/.test(norm(o.nivel_confianca))).length;
  if (baixaConf) acoes.push(`${baixaConf} oferta(s) de baixa confiança na coleta — confirmar antes de reagir.`);
  const semVenda = reagir.filter((r) => !r.vendemos).length;
  if (semVenda) acoes.push(`${semVenda} produto(s) que eles baixaram e a gente quase não vende — pode ignorar.`);

  return { loja, periodo, panorama, concorrentes, categorias, onde_reagir: reagir.slice(0, 40), resumo, acoes, feeds: ctx.feeds };
}

module.exports = { analisarConcorrencia };
