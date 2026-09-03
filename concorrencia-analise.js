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
const { categoriaCanonica, expandirSuperGrupo } = require("./categorias");
const promoPricing = require("./marketing/promo-pricing");

const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));
const CFG_STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "marketing-stock.json"), "utf8"));
const PISO_MARGEM = CFG_STOCK.margem_pct_minima_para_anunciar != null ? CFG_STOCK.margem_pct_minima_para_anunciar : 0.1;
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const round = (n, d) => (n == null ? null : Math.round((n + Number.EPSILON) * Math.pow(10, d ?? 2)) / Math.pow(10, d ?? 2));

// "nossas promoções" = ação promocional DELIBERADA por categoria, da TABELA DE PLANEJAMENTO
// de promoções (o "tabelão"/encarte que a loja monta — parsers/promocoes.js). Fallback:
// produtos de campanhas cadastradas. NÃO usamos a coluna "preço promocional" do feed de
// estoque (vinha preenchida para o catálogo inteiro). Categorias do calendário entram como
// "recorrente" (sinal binário).
function nossasPromocoesPorCategoria(loja, refDate) {
  const porCategoria = new Map();
  const exemplos = new Map();
  let total = 0, fonte = null;
  const add = (catRaw, n, exs) => {
    const cat = categoriaCanonica(catRaw) || "(sem categoria)";
    porCategoria.set(cat, (porCategoria.get(cat) || 0) + n);
    if (exs) exemplos.set(cat, [...(exemplos.get(cat) || []), ...exs].slice(0, 6));
    total += n;
  };
  const plan = db.promocoesPorCategoria(loja, refDate);
  if (plan.size) {
    fonte = "tabela de planejamento de promoções";
    for (const [cat, e] of plan) add(cat, e.n, e.exemplos);
    return { porCategoria, exemplos, total, fonte };
  }
  // fallback: campanhas cadastradas
  try {
    const lid = db.lojaId(loja);
    const corte = new Date(new Date(refDate + "T12:00:00").getTime() - 45 * 86400000).toISOString().slice(0, 10);
    const rows = db.db
      .prepare(
        `SELECT COALESCE(pr.categoria_manual, pr.categoria) AS categoria, COUNT(DISTINCT cp.produto_id) AS n
           FROM campanha_produtos cp JOIN campanhas c ON c.id = cp.campanha_id JOIN produtos pr ON pr.id = cp.produto_id
          WHERE c.loja_id = ? AND (c.status IN ('ativa','aprovada','em_andamento') OR c.data_fim IS NULL OR c.data_fim >= ?)
          GROUP BY 1`
      )
      .all(lid, corte);
    for (const r of rows) add(r.categoria, r.n);
    if (total) fonte = "campanhas cadastradas";
  } catch (e) { /* sem campanhas */ }
  return { porCategoria, exemplos, total, fonte };
}

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
  // rótulo da coleta do concorrente -> vocabulário canônico (junta com o nosso catálogo)
  for (const o of ofertas) o.categoria = o.categoria ? categoriaCanonica(o.categoria) : o.categoria;
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
  // agrega o momentum de categoria já no vocabulário canônico
  const _catTend = new Map();
  for (const c of ctx.categoriasTendencia || []) {
    const k = categoriaCanonica(c.categoria);
    const e = _catTend.get(k) || { categoria: k, receita_30d: 0, var_pct: null, _n: 0, _somaVar: 0 };
    e.receita_30d += c.receita_30d || 0;
    if (c.var_pct != null) { e._somaVar += c.var_pct; e._n++; }
    _catTend.set(k, e);
  }
  for (const e of _catTend.values()) e.var_pct = e._n ? Math.round(e._somaVar / e._n) : null;
  const catTendencia = _catTend;
  const refDate = ctx.analiseProdutos.refDate || db.getUltimaDataVenda(loja);

  // melhor alternativa da MESMA categoria para promover no lugar de um item que não dá pra cobrir
  function alternativaNaCategoria(categoria, exceto) {
    const alvo = expandirSuperGrupo(categoria); // "Bebê" cobre Fraldas + Leite Infantil
    const cand = nossosProdutos
      .filter((p) =>
        alvo.includes(categoriaCanonica(p.categoria)) &&
        p.ean !== exceto &&
        norm(p.descricao) !== norm(exceto || "") &&
        !p.do_not_promote &&
        (p.margem_pct == null || p.margem_pct >= PISO_MARGEM) &&
        ["NORMAL", "OPORTUNIDADE", "ATENCAO", "SEM_ESTOQUE"].includes(p.cobertura_rotulo) &&
        (p.venda_media_diaria && p.venda_media_diaria.d30) > 0
      )
      .sort((a, b) => b.opportunity.score - a.opportunity.score);
    const s = cand[0];
    if (!s) return null;
    return {
      produto: s.descricao, ean: s.ean, categoria: s.categoria,
      preco: s.preco_atual != null ? s.preco_atual : s.preco_praticado,
      margem_pct: s.margem_pct, opportunity: s.opportunity.score, cobertura: s.cobertura_rotulo,
      motivo: s.margem_pct != null
        ? `mesma categoria, margem de ${(s.margem_pct * 100).toFixed(0)}% sustenta a promoção`
        : "mesma categoria, sem custo cadastrado mas gira bem",
    };
  }

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

  // ---- SHARE OF PROMOTIONS: nossas promoções × ofertas de concorrente, por categoria ----
  // promoções são forward-looking: usa hoje (ou o último dia de dados, o que for maior)
  const hojeIso = new Date().toISOString().slice(0, 10);
  const nossasPromo = nossasPromocoesPorCategoria(loja, hojeIso > refDate ? hojeIso : refDate);
  const catsRecorrentes = new Set((cfg.campanhas || []).flatMap((c) => c.categorias || []).map((c) => categoriaCanonica(c)));
  const catInfo = new Map(categorias.map((c) => [c.categoria, c]));
  const todasCats = new Set([...catInfo.keys(), ...nossasPromo.porCategoria.keys(), ...catsRecorrentes]);
  // conta as nossas promoções somando os membros do super-grupo (ex.: concorrente diz "Bebê"
  // -> soma Bebê + Fraldas + Leite Infantil das nossas)
  const nossasNaCat = (cat) => expandirSuperGrupo(cat).reduce((s, m) => s + (nossasPromo.porCategoria.get(m) || 0), 0);
  const recorrenteNaCat = (cat) => expandirSuperGrupo(cat).some((m) => catsRecorrentes.has(m));
  const sharePorCat = [...todasCats].map((cat) => {
    const ci = catInfo.get(cat) || {};
    const nossas = nossasNaCat(cat);
    const deles = ci.abaixo != null ? ci.abaixo : 0; // ofertas do concorrente abaixo do nosso preço
    const ofertasDeles = ci.ofertas != null ? ci.ofertas : 0;
    const recorrente = recorrenteNaCat(cat);
    const pressao = ci.pressao || (ofertasDeles ? "MÉDIA" : "BAIXA");
    const receita = ci.nossa_receita_30d || null;
    const relevante = receita == null || receita >= 500;
    const denom = nossas + Math.max(deles, ofertasDeles);
    const share_pct = denom > 0 ? Math.round((nossas / denom) * 100) : null;
    // "deles" = ofertas do concorrente ABAIXO do nosso preço (pressão real); ofertasDeles = volume de comunicação
    const temAcaoNossa = nossas > 0 || recorrente;
    let veredito;
    if (ofertasDeles === 0 && !temAcaoNossa) veredito = "sem atividade promocional na categoria";
    else if (deles >= 2 && !temAcaoNossa) veredito = relevante ? "subcomunicando — concorrência abaixo do nosso preço e sem ação nossa" : "concorrência abaixo do nosso preço, mas categoria de pouca receita nossa";
    else if (deles === 0 && ofertasDeles >= 6 && !temAcaoNossa) veredito = "concorrência comunicando forte (mas não abaixo do nosso preço) — avaliar presença";
    else if (temAcaoNossa && ofertasDeles === 0 && pressao === "BAIXA") veredito = "esforço promocional sem pressão que justifique — reavaliar prioridade";
    else veredito = "equilibrado";
    return {
      categoria: cat,
      nossas_promocoes: nossas,
      nossas_exemplos: expandirSuperGrupo(cat).flatMap((m) => (nossasPromo.exemplos && nossasPromo.exemplos.get(m)) || []).slice(0, 4),
      promo_recorrente: recorrente,
      ofertas_concorrentes: ofertasDeles,
      ofertas_abaixo_do_nosso: deles,
      pressao, nossa_receita_30d: receita, relevante,
      share_pct, veredito,
    };
  }).sort((a, b) => {
    const rank = (v) => (/^subcomunicando/.test(v.veredito) ? 0 : /reavaliar prioridade/.test(v.veredito) ? 1 : /comunicando forte/.test(v.veredito) ? 2 : 3);
    return rank(a) - rank(b) || b.ofertas_abaixo_do_nosso - a.ofertas_abaixo_do_nosso || b.ofertas_concorrentes - a.ofertas_concorrentes;
  });
  const shareResumo = [];
  const sub = sharePorCat.filter((c) => /^subcomunicando/.test(c.veredito));
  const exc = sharePorCat.filter((c) => /reavaliar prioridade/.test(c.veredito));
  if (sub.length) shareResumo.push(`Subcomunicando (concorrência abaixo do nosso preço, sem ação nossa): ${sub.slice(0, 3).map((c) => `${c.categoria} (${c.ofertas_abaixo_do_nosso} ofertas deles abaixo do nosso preço)`).join("; ")}.`);
  if (exc.length) shareResumo.push(`Esforço sem pressão (temos campanha, concorrência parada): ${exc.slice(0, 3).map((c) => c.categoria).join("; ")}.`);
  if (!sub.length && !exc.length) shareResumo.push("Presença promocional equilibrada frente à concorrência nas categorias com dado.");
  const share_promocoes = {
    fonte_nossas: nossasPromo.fonte
      ? `${nossasPromo.fonte} + calendário de campanhas`
      : "sem tabela de promoções nem campanhas cadastradas — só o calendário de campanhas (config/lojas.json)",
    nossas_promocoes_total: nossasPromo.total,
    ofertas_concorrentes_total: ofertas.length,
    por_concorrente: [...porConc.values()].filter((c) => c.temColeta).map((c) => ({ concorrente: c.concorrente, ofertas: c.ofertas })).sort((a, b) => b.ofertas - a.ofertas).concat([{ concorrente: `${loja} (nós)`, ofertas: nossasPromo.total, nos: true }]),
    por_categoria: sharePorCat,
    resumo: shareResumo,
  };

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
    let cobrivel = true;
    if (!vendemos) { veredito = "a gente quase não vende — pode ignorar"; cobrivel = false; }
    else if (margem == null) veredito = "avaliar (sem custo cadastrado)";
    else if (margem >= 0.08) veredito = "dá para cobrir com margem";
    else if (margem > 0) { veredito = "cobrir aperta a margem"; cobrivel = false; }
    else { veredito = "não cobrir — margem insuficiente"; cobrivel = false; }
    // contra-ataque: se não vale cobrir esse SKU mas vendemos na categoria, promover outro no lugar
    const contra = vendemos && !cobrivel && o.categoria ? alternativaNaCategoria(o.categoria, p ? p.ean : o.produto) : null;
    reagir.push({
      produto: o.produto, produto_casado: o.produto_casado || null, categoria: o.categoria,
      concorrente: o.concorrente, confianca: o.nivel_confianca,
      preco_deles: o.preco_promo, nosso_preco: round(nossoPreco, 2), diff_pct: diffPct,
      vendemos, nossas_unid_30d: un30, nossa_receita_30d: round(rec30, 2),
      nossa_classe: p ? p.classe : null, nossa_margem_pct: margem, nossa_cobertura: p ? p.cobertura_rotulo : null,
      score, veredito,
      contra_ataque: contra,
      _pid: p ? p.produto_id : null,
    });
  }
  reagir.sort((a, b) => b.score - a.score);

  // preço recomendado para reagir (mesmo motor da tela Precificação) — nos itens que vendemos.
  // Anota também o preço-alvo p/ igualar o concorrente e se o motor topa descer até lá.
  try {
    const ids = reagir.filter((r) => r._pid).slice(0, 40).map((r) => r._pid);
    const pr = promoPricing.precoRapido(loja, {}, ids);
    for (const r of reagir) {
      const rec = r._pid && pr.get(String(r._pid));
      const precoAlvo = r.nosso_preco && r.preco_deles ? round(r.preco_deles, 2) : null;
      const descAlvo = r.nosso_preco && r.preco_deles ? round((1 - r.preco_deles / r.nosso_preco) * 100, 1) : null;
      r.reagir_com = rec ? {
        preco_recomendado: rec.preco_recomendado, desconto_pct: rec.desconto_pct,
        margem_pct_na_promo: rec.margem_pct_na_promo, lucro_incremental_previsto: rec.lucro_incremental_previsto,
        duracao_dias: rec.duracao_dias, elasticidade_premissa: true,
        cobre_o_concorrente: precoAlvo != null ? rec.preco_recomendado <= precoAlvo + 0.01 : null,
      } : null;
      r.preco_para_igualar = precoAlvo;
      r.desconto_para_igualar_pct = descAlvo;
      delete r._pid;
    }
  } catch (e) { for (const r of reagir) delete r._pid; }

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
  if (topReagir.length) acoes.push(`Cobrir preço / comunicar "melhor preço" em: ${topReagir.filter((r) => !r.contra_ataque).map((r) => r.produto).slice(0, 4).join("; ") || "—"}.`);
  const comContra = reagir.filter((r) => r.contra_ataque).slice(0, 4);
  if (comContra.length) acoes.push(`Onde não vale cobrir, promover no lugar (mesma categoria, margem sustenta): ${comContra.map((r) => `${r.contra_ataque.produto} (no lugar de ${r.produto})`).join("; ")}.`);
  if (sub.length) acoes.push(`Aumentar presença promocional em: ${sub.slice(0, 3).map((c) => c.categoria).join(", ")} — concorrência ativa e a gente ausente.`);
  if (exc.length) acoes.push(`Reduzir esforço promocional em: ${exc.slice(0, 3).map((c) => c.categoria).join(", ")} — sem pressão que justifique.`);
  if (catsPressao.length) acoes.push(`Montar campanha de defesa nas categorias ${catsPressao.slice(0, 3).join(", ")} (ver Intelligence → Recomendações).`);
  const baixaConf = ofertas.filter((o) => /baix/.test(norm(o.nivel_confianca))).length;
  if (baixaConf) acoes.push(`${baixaConf} oferta(s) de baixa confiança na coleta — confirmar antes de reagir.`);
  const semVenda = reagir.filter((r) => !r.vendemos).length;
  if (semVenda) acoes.push(`${semVenda} produto(s) que eles baixaram e a gente quase não vende — pode ignorar.`);

  return { loja, periodo, panorama, concorrentes, categorias, share_promocoes, onde_reagir: reagir.slice(0, 40), resumo, acoes, feeds: ctx.feeds };
}

module.exports = { analisarConcorrencia };
