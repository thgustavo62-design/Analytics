// Ontologia — modelo de objetos interligados (estilo Palantir): loja, categorias, canais,
// campanhas, concorrentes e os achados da Análise Comercial, todos como nós de um grafo,
// ligados por arestas com significado. É o que a tela "Conexões" desenha.
//
// Tudo determinístico a partir do que já existe (vendas + concorrência + config); se houver
// Análise Comercial do mês, os riscos/oportunidades/ações entram como nós ligados aos
// objetos que eles tocam.

const { analiseProfunda } = require("./analytics-deep");
const { classificar } = require("./classify");

const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const brl = (v) => "R$ " + (v == null ? 0 : v).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function construirOntologia({ loja, periodo, vendasRows, concRows, lojaCfg, analiseComercial }) {
  const deep = analiseProfunda(vendasRows, { lojaCfg, concorrencia: concRows || [] });
  const nodes = [];
  const edges = [];
  const byId = new Set();
  const add = (n) => {
    if (byId.has(n.id)) return n.id;
    byId.add(n.id);
    nodes.push(n);
    return n.id;
  };
  const link = (de, para, tipo, extra = {}) => {
    if (byId.has(de) && byId.has(para) && de !== para) edges.push({ de, para, tipo, ...extra });
  };

  // ---- centro: loja/período ----
  const k = deep.operacao;
  add({
    id: "loja", tipo: "loja", rotulo: loja, sub: periodo,
    metricas: { Faturamento: brl(k.faturamento), "Ticket médio": brl(k.ticket_medio), "Ticket mediano": brl(k.ticket_mediano), Cupons: k.cupons.toLocaleString("pt-BR"), "SKUs": k.skus_distintos.toLocaleString("pt-BR") },
  });

  // ---- categorias ----
  const catIds = {};
  deep.categorias.forEach((c, i) => {
    const id = "cat:" + c.categoria;
    catIds[c.categoria] = id;
    add({
      id, tipo: "categoria", rotulo: c.categoria, valor: c.faturamento,
      destaque: i === 0 && c.participacao_pct >= 50 ? "atencao" : null,
      metricas: { Receita: brl(c.faturamento), "Participação": c.participacao_pct + "%", Cupons: c.cupons.toLocaleString("pt-BR") },
    });
    link("loja", id, "vende", { peso: Math.max(1, c.participacao_pct) });
  });
  // Pareto (concentração de SKUs)
  add({
    id: "sinal:pareto", tipo: "sinal", rotulo: "Concentração de SKUs",
    metricas: { "80% da receita": k.pareto_skus_80pct + " de " + k.skus_distintos + " SKUs" },
    nota: `${k.pareto_skus_80pct} SKUs fazem 80% do faturamento — atenção a ruptura desses itens.`,
  });
  link("loja", "sinal:pareto", "sinal");

  // ---- canais ----
  deep.canais.forEach((ch) => {
    const id = "canal:" + ch.nome;
    const alto = /Conv[eê]nio/i.test(ch.nome) && ch.faturamento_pct >= 15;
    add({
      id, tipo: "canal", rotulo: ch.nome, destaque: alto ? "atencao" : null,
      metricas: { Cupons: `${ch.cupons.toLocaleString("pt-BR")} (${ch.cupons_pct}%)`, Faturamento: `${brl(ch.faturamento)} (${ch.faturamento_pct}%)`, Ticket: brl(ch.ticket) },
      nota: alto ? `${ch.faturamento_pct}% do faturamento passa por convênio (ticket ${brl(ch.ticket)} vs. balcão). Concentração a monitorar.` : null,
    });
    link("loja", id, "canal", { peso: Math.max(1, ch.faturamento_pct) });
  });
  // concentração de convênio numa conta só
  const topConv = (deep.concentracao_convenio || [])[0];
  if (topConv && topConv.pct >= 8) {
    add({
      id: "sinal:conta-convenio", tipo: "sinal", rotulo: "Conta de convênio concentrada", destaque: "risco",
      metricas: { Conta: topConv.id, Faturamento: `${brl(topConv.faturamento)} (${topConv.pct}%)`, Cupons: topConv.cupons.toLocaleString("pt-BR") },
      nota: `A conta ${topConv.id} responde por ${topConv.pct}% do mês. Se ela sai, o faturamento vira — risco material.`,
    });
    link("sinal:conta-convenio", "canal:Convênio", "explica");
    link("loja", "sinal:conta-convenio", "risco");
  }

  // ---- campanhas ----
  const campIds = {};
  deep.campanhas.forEach((camp) => {
    const id = "camp:" + camp.nome;
    campIds[camp.nome] = id;
    const p = camp.participacao_categoria_nos_dias_de_campanha?.participacao_media_pct;
    const bl = (camp.baselines || []).map((x) => x.participacao_media_pct).filter((v) => v != null);
    const baseMed = bl.length ? bl.reduce((a, c) => a + c, 0) / bl.length : null;
    const pp = p != null && baseMed != null ? Math.round((p - baseMed) * 10) / 10 : null;
    const fatC = camp.faturamento_dias_campanha?.faturamento_medio;
    const fatF = camp.faturamento_dias_fora?.faturamento_medio;
    const difFat = fatC != null && fatF ? Math.round(((fatC - fatF) / fatF) * 1000) / 10 : null;
    add({
      id, tipo: "campanha", rotulo: camp.nome,
      destaque: pp != null ? (pp >= 3 ? "oportunidade" : pp <= 0 ? "risco" : null) : null,
      metricas: {
        Dias: camp.dias_semana.map((d) => WD[d]).join(", "),
        "Part. no dia": p != null ? p + "%" : "—",
        "Baseline": baseMed != null ? baseMed.toFixed(1) + "%" : "—",
        "Incremental": pp != null ? (pp >= 0 ? "+" : "") + pp + " p.p." : "—",
        "Fat. dia vs. fora": difFat != null ? (difFat >= 0 ? "+" : "") + difFat + "%" : "—",
      },
      nota:
        pp == null ? null :
        pp <= 0 ? `A participação de ${camp.categorias.join("/")} nos dias de campanha (${p}%) está igual ou abaixo do baseline (${baseMed.toFixed(1)}%). A campanha mantém o ritmo, não gera fluxo extra mensurável.` :
        `A participação de ${camp.categorias.join("/")} sobe ${pp} p.p. nos dias de campanha. Sinal positivo — confirmar com margem.`,
    });
    link("loja", id, "campanha");
    camp.categorias.forEach((cat) => {
      if (catIds[cat]) link(id, catIds[cat], "promove", { rotulo: pp != null ? (pp >= 0 ? "+" : "") + pp + " p.p." : null });
    });
  });

  // ---- concorrentes -> categorias (pressão de preço) ----
  const porConc = new Map();
  for (const o of concRows || []) {
    if (!o.concorrente) continue;
    const catNossa = classificar(o.produto || "");
    if (!porConc.has(o.concorrente)) porConc.set(o.concorrente, { ofertas: 0, abaixo: 0, cats: new Map(), exemplos: [] });
    const e = porConc.get(o.concorrente);
    e.ofertas++;
    if (!e.cats.has(catNossa)) e.cats.set(catNossa, { ofertas: 0, abaixo: 0 });
    e.cats.get(catNossa).ofertas++;
    if (o.abaixo_do_nosso) {
      e.abaixo++;
      e.cats.get(catNossa).abaixo++;
      if (e.exemplos.length < 4) e.exemplos.push(`${o.produto} — R$ ${(+o.preco_promo).toFixed(2)} vs. nosso R$ ${(+o.nosso_preco_medio).toFixed(2)}`);
    }
  }
  for (const [nome, e] of porConc) {
    if (!e.ofertas) continue;
    const id = "conc:" + nome;
    add({
      id, tipo: "concorrente", rotulo: nome,
      destaque: e.abaixo >= 5 ? "risco" : null,
      metricas: { "Ofertas na coleta": e.ofertas, "Abaixo do nosso preço": e.abaixo },
      lista: e.exemplos.length ? { titulo: "Exemplos abaixo do nosso", itens: e.exemplos } : null,
    });
    link("loja", id, "concorrente");
    for (const [cat, s] of e.cats) {
      if (s.abaixo > 0 && catIds[cat]) link(id, catIds[cat], "pressiona", { peso: s.abaixo, rotulo: `${s.abaixo} abaixo` });
    }
  }

  // ---- cruzamento: campanha promove categoria que o concorrente está pressionando ----
  for (const camp of deep.campanhas) {
    for (const cat of camp.categorias) {
      let abaixoTotal = 0;
      const concs = [];
      for (const [nome, e] of porConc) {
        const s = e.cats.get(cat);
        if (s && s.abaixo > 0) {
          abaixoTotal += s.abaixo;
          concs.push(`${nome} (${s.abaixo})`);
        }
      }
      if (abaixoTotal >= 3) {
        const id = `sinal:pressao:${camp.nome}:${cat}`;
        add({
          id, tipo: "sinal", rotulo: `Campanha sob pressão em ${cat}`, destaque: "risco",
          metricas: { Campanha: camp.nome, Categoria: cat, "Ofertas de concorrente abaixo": abaixoTotal },
          nota: `A campanha "${camp.nome}" promove ${cat}, mas ${concs.join(", ")} têm ${abaixoTotal} ofertas abaixo do nosso preço nessa categoria. O desconto da campanha pode estar só cobrindo a diferença de preço — medir a margem incremental antes de manter.`,
        });
        if (campIds[camp.nome]) link(id, campIds[camp.nome], "afeta");
        if (catIds[cat]) link(id, catIds[cat], "afeta");
        for (const [nome, e] of porConc) if (e.cats.get(cat)?.abaixo > 0) link("conc:" + nome, id, "causa");
        link("loja", id, "risco");
      }
    }
  }

  // ---- achados da Análise Comercial (se houver) ----
  if (analiseComercial) {
    const a = analiseComercial;
    const alvos = [
      ...nodes.filter((n) => ["categoria", "campanha", "canal", "concorrente"].includes(n.tipo)).map((n) => ({ id: n.id, key: norm(n.rotulo) })),
    ];
    const ligarPorTexto = (fromId, ...textos) => {
      const t = norm(textos.filter(Boolean).join(" "));
      for (const alvo of alvos) if (alvo.key.length > 3 && t.includes(alvo.key)) link(fromId, alvo.id, "sobre");
    };

    const dp = a.diagnostico_executivo?.decisao_principal;
    if (dp?.acao) {
      add({ id: "ac:decisao", tipo: "decisao", rotulo: "Decisão principal", destaque: "decisao", metricas: { Impacto: dp.impacto_estimado_mes != null ? brl(dp.impacto_estimado_mes) + "/mês" : "—", Prazo: dp.prazo || "—", Confiança: dp.confianca || "—" }, nota: dp.acao });
      link("loja", "ac:decisao", "decisao");
      ligarPorTexto("ac:decisao", dp.acao);
    }
    (a.riscos || []).forEach((r, i) => {
      const id = "ac:risco:" + i;
      add({ id, tipo: "risco", rotulo: r.titulo, destaque: "risco", metricas: { Gravidade: r.gravidade || "—", "Em risco": r.valor_em_risco != null ? brl(r.valor_em_risco) : "—" }, nota: r.evidencia || null });
      link("loja", id, "risco");
      ligarPorTexto(id, r.titulo, r.evidencia);
    });
    (a.oportunidades || []).forEach((o, i) => {
      const id = "ac:opo:" + i;
      add({ id, tipo: "oportunidade", rotulo: o.titulo, destaque: "oportunidade", metricas: { Impacto: o.impacto_estimado_mes != null ? brl(o.impacto_estimado_mes) + "/mês" : "—", Confiança: o.confianca || "—" }, nota: (o.premissas || []).join("; ") || null });
      link("loja", id, "oportunidade");
      ligarPorTexto(id, o.titulo, (o.premissas || []).join(" "));
    });
    (a.acoes || []).forEach((x, i) => {
      const id = "ac:acao:" + i;
      add({ id, tipo: "acao", rotulo: x.acao, metricas: { Responsável: x.responsavel || "—", Prazo: x.prazo_dias != null ? x.prazo_dias + " d" : "—", Impacto: x.impacto_estimado_mes != null ? brl(x.impacto_estimado_mes) + "/mês" : "—" } });
      link("loja", id, "acao");
      ligarPorTexto(id, x.acao);
    });
    (a.campanhas || []).forEach((c) => {
      const alvo = deep.campanhas.find((d) => norm(d.nome).includes(norm(c.nome).split(" (")[0])) || null;
      if (alvo && campIds[alvo.nome]) {
        const id = "ac:camp:" + norm(c.nome).replace(/\W+/g, "-");
        add({ id, tipo: "veredito", rotulo: `${c.decisao || "?"} — ${c.nome}`, destaque: c.decisao === "ESCALAR" ? "oportunidade" : /ENCERRAR|REDUZIR/.test(c.decisao) ? "risco" : null, metricas: { "Margem incr./mês": c.margem_incremental_mes != null ? brl(c.margem_incremental_mes) : "—", "Fat. incr.": c.faturamento_incremental_pct != null ? c.faturamento_incremental_pct + "%" : "—" }, nota: c.justificativa || null });
        link(id, campIds[alvo.nome], "veredito");
        link("loja", id, "veredito");
      }
    });
  }

  return {
    loja, periodo,
    gerado_em: new Date().toISOString(),
    tem_analise_comercial: !!analiseComercial,
    contagem: nodes.reduce((acc, n) => ((acc[n.tipo] = (acc[n.tipo] || 0) + 1), acc), {}),
    nodes,
    edges,
  };
}

module.exports = { construirOntologia };
