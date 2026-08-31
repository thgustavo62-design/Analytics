// Agregados "profundos" para o Motor de Análise Comercial: tudo que os Passos 1–8 do
// prompt precisam, calculado de forma DETERMINÍSTICA (o LLM interpreta, não faz conta).
// Entrada: linhas de vendas de UMA loja/mês (já com .categoria, e emp_id/cli_id se houver),
// mais o calendário de campanhas e a coleta de concorrentes do período.

const WD = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;

function mediana(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function desvioPadrao(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1));
}
function weekdayOf(iso) {
  return new Date(iso + "T12:00:00").getDay();
}
const zeros = (s) => !s || /^0+$/.test(String(s).trim());

// agrupa por lançamento (cupom)
function agruparCupons(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.lancamento)) {
      map.set(r.lancamento, {
        lanc: r.lancamento, total: 0, itens: 0, data: r.data, dow: weekdayOf(r.data),
        usuario: r.usuario || null, emp_id: r.emp_id || null, cli_id: r.cli_id || null,
        temTaxaEntrega: false, aVista: 0, aPrazo: 0, porCat: {},
      });
    }
    const c = map.get(r.lancamento);
    c.total += r.valor_liquido;
    c.itens += 1;
    c.porCat[r.categoria] = (c.porCat[r.categoria] || 0) + r.valor_liquido;
    if (/TAXA DE ENTREGA/i.test(r.descricao)) c.temTaxaEntrega = true;
    if (r.forma_pagto === "A VISTA") c.aVista += r.valor_liquido;
    else if (r.forma_pagto === "A PRAZO") c.aPrazo += r.valor_liquido;
  }
  return [...map.values()];
}

function porDiaSemana(cs) {
  const porData = new Map();
  for (const c of cs) {
    if (!porData.has(c.data)) porData.set(c.data, { fat: 0, cupons: 0, dow: c.dow });
    const d = porData.get(c.data);
    d.fat += c.total;
    d.cupons += 1;
  }
  const buckets = {};
  for (const [, d] of porData) (buckets[d.dow] = buckets[d.dow] || []).push(d);
  return [1, 2, 3, 4, 5, 6, 0].map((dow) => {
    const dias = buckets[dow] || [];
    const fats = dias.map((x) => x.fat);
    const nCupons = dias.reduce((a, x) => a + x.cupons, 0);
    const fatTot = fats.reduce((a, b) => a + b, 0);
    return {
      dia_semana: dow,
      rotulo: WD[dow][0].toUpperCase() + WD[dow].slice(1),
      n: dias.length,
      faturamento_medio: round2(fats.length ? fatTot / fats.length : 0),
      mediana: round2(mediana(fats)),
      desvio_padrao: round2(desvioPadrao(fats)),
      cupons_medio: dias.length ? Math.round(nCupons / dias.length) : 0,
      ticket: round2(nCupons ? fatTot / nCupons : 0),
    };
  });
}

// participação de um conjunto de CATEGORIAS no faturamento DO PRÓPRIO DIA, média sobre um
// conjunto de dias-da-semana. Neutraliza o efeito do dia da semana (método correto de
// incrementalidade — Passo 3 do prompt).
function participacaoPorDia(cs, categorias, dows) {
  const porData = new Map();
  for (const c of cs) {
    if (!dows.includes(c.dow)) continue;
    if (!porData.has(c.data)) porData.set(c.data, { total: 0, cat: 0 });
    const d = porData.get(c.data);
    d.total += c.total;
    for (const cat of categorias) d.cat += c.porCat[cat] || 0;
  }
  const parts = [...porData.values()].filter((d) => d.total > 0).map((d) => d.cat / d.total);
  return {
    dias: parts.length,
    participacao_media_pct: parts.length ? round1((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : null,
  };
}

function faturamentoMedioDias(cs, dows) {
  const porData = new Map();
  for (const c of cs) {
    if (!dows.includes(c.dow)) continue;
    porData.set(c.data, (porData.get(c.data) || 0) + c.total);
  }
  const fats = [...porData.values()];
  return {
    dias: fats.length,
    faturamento_medio: round2(fats.length ? fats.reduce((a, b) => a + b, 0) / fats.length : 0),
    desvio_padrao: round2(desvioPadrao(fats)),
  };
}

function topN(map, total, n) {
  return [...map.entries()]
    .map(([k, v]) => ({ id: k, cupons: v.cupons, faturamento: round2(v.fat), pct: round1((v.fat / total) * 100) }))
    .sort((a, b) => b.faturamento - a.faturamento)
    .slice(0, n);
}

// resumo da coleta de concorrentes (linhas de concorrencia_ofertas do período)
function resumoConcorrencia(concRows) {
  if (!concRows || !concRows.length) return null;
  const porConc = new Map();
  for (const o of concRows) {
    const k = o.concorrente || "(?)";
    if (!porConc.has(k)) porConc.set(k, { concorrente: k, ofertas: 0, comparaveis: 0, abaixo: 0, exemplos: [] });
    const e = porConc.get(k);
    e.ofertas += 1;
    if (o.abaixo_do_nosso != null) {
      e.comparaveis += 1;
      if (o.abaixo_do_nosso) {
        e.abaixo += 1;
        if (e.exemplos.length < 6)
          e.exemplos.push({ produto: o.produto, categoria: o.categoria || null, promo: o.preco_promo, nosso: o.nosso_preco_medio });
      }
    }
  }
  return {
    total_ofertas: concRows.length,
    comparaveis: concRows.filter((o) => o.abaixo_do_nosso != null).length,
    abaixo_do_nosso: concRows.filter((o) => !!o.abaixo_do_nosso).length,
    por_concorrente: [...porConc.values()].sort((a, b) => b.abaixo - a.abaixo || b.ofertas - a.ofertas),
    nota: "casamento aproximado de nome/marca contra o nosso preço médio praticado no mês — direcional",
  };
}

/**
 * @param {Array} rows  linhas de vendas (uma loja/mês), já com .categoria
 * @param {object} opts { lojaCfg, rowsMesAnterior, concorrencia }
 */
function analiseProfunda(rows, opts = {}) {
  const { lojaCfg = {}, rowsMesAnterior = null, concorrencia = null } = opts;
  const campanhasCfg = Array.isArray(lojaCfg.campanhas) ? lojaCfg.campanhas : [];

  const cs = agruparCupons(rows);
  const faturamento = round2(cs.reduce((s, c) => s + c.total, 0));
  const nCupons = cs.length;
  const totaisCupom = cs.map((c) => c.total);
  const skus = new Set(rows.map((r) => r.barras || r.descricao));

  // Pareto: quantos SKUs fazem 80% do faturamento
  const porSku = new Map();
  for (const r of rows) porSku.set(r.descricao, (porSku.get(r.descricao) || 0) + r.valor_liquido);
  const skuVals = [...porSku.values()].sort((a, b) => b - a);
  let acc = 0;
  let pareto80 = 0;
  for (const v of skuVals) {
    acc += v;
    pareto80++;
    if (acc >= faturamento * 0.8) break;
  }

  const aVista = round2(cs.reduce((s, c) => s + c.aVista, 0));

  // categorias
  const catMap = new Map();
  for (const r of rows) {
    if (!catMap.has(r.categoria)) catMap.set(r.categoria, { fat: 0, lancs: new Set() });
    const e = catMap.get(r.categoria);
    e.fat += r.valor_liquido;
    e.lancs.add(r.lancamento);
  }
  const categorias = [...catMap.entries()]
    .map(([categoria, e]) => ({ categoria, faturamento: round2(e.fat), participacao_pct: round1((e.fat / faturamento) * 100), cupons: e.lancs.size }))
    .sort((a, b) => b.faturamento - a.faturamento);

  // canais sem sobreposição: convênio / delivery / balcão
  const canalAcc = { "Convênio": { fat: 0, cupons: 0 }, "Delivery (taxa de entrega)": { fat: 0, cupons: 0 }, "Balcão": { fat: 0, cupons: 0 } };
  for (const c of cs) {
    const conv = !zeros(c.emp_id);
    const key = conv ? "Convênio" : c.temTaxaEntrega ? "Delivery (taxa de entrega)" : "Balcão";
    canalAcc[key].fat += c.total;
    canalAcc[key].cupons += 1;
  }
  const canais = Object.entries(canalAcc)
    .filter(([, v]) => v.cupons > 0)
    .map(([nome, v]) => ({
      nome, cupons: v.cupons, cupons_pct: round1((v.cupons / nCupons) * 100),
      faturamento: round2(v.fat), faturamento_pct: round1((v.fat / faturamento) * 100),
      ticket: round2(v.fat / v.cupons),
    }));

  // concentração por cliente e por convênio
  const cliMap = new Map();
  const empMap = new Map();
  for (const c of cs) {
    if (!zeros(c.cli_id)) {
      const e = cliMap.get(c.cli_id) || { fat: 0, cupons: 0 };
      e.fat += c.total; e.cupons += 1; cliMap.set(c.cli_id, e);
    }
    if (!zeros(c.emp_id)) {
      const e = empMap.get(c.emp_id) || { fat: 0, cupons: 0 };
      e.fat += c.total; e.cupons += 1; empMap.set(c.emp_id, e);
    }
  }

  // operadores
  const opMap = new Map();
  for (const c of cs) {
    const k = c.usuario || "?";
    const e = opMap.get(k) || { fat: 0, cupons: 0, itens: 0, entregas: 0 };
    e.fat += c.total; e.cupons += 1; e.itens += c.itens; if (c.temTaxaEntrega) e.entregas += 1;
    opMap.set(k, e);
  }
  const operadores = [...opMap.entries()]
    .map(([usuario, e]) => ({
      usuario, cupons: e.cupons, faturamento: round2(e.fat),
      ticket: round2(e.fat / e.cupons), itens_por_cupom: round1(e.itens / e.cupons), entregas: e.entregas,
    }))
    .sort((a, b) => b.faturamento - a.faturamento);

  // campanhas — incrementalidade intradiária, com 2 baselines, por campanha configurada
  const campanhas = campanhasCfg.map((camp) => {
    const dias = Array.isArray(camp.dias) ? camp.dias : [];
    const cats = Array.isArray(camp.categorias) ? camp.categorias : [];
    const outros = [1, 2, 3, 4, 5, 6, 0].filter((d) => !dias.includes(d));
    const uteis = outros.filter((d) => d >= 1 && d <= 4);
    const fds = outros.filter((d) => d === 5 || d === 6 || d === 0);
    return {
      nome: camp.nome,
      dias_semana: dias,
      categorias: cats,
      participacao_categoria_nos_dias_de_campanha: participacaoPorDia(cs, cats, dias),
      baselines: [
        { nome: "dias fora da campanha (úteis)", ...participacaoPorDia(cs, cats, uteis.length ? uteis : outros) },
        { nome: "dias fora da campanha (sex–dom)", ...participacaoPorDia(cs, cats, fds.length ? fds : outros) },
      ],
      faturamento_dias_campanha: faturamentoMedioDias(cs, dias),
      faturamento_dias_fora: faturamentoMedioDias(cs, outros),
    };
  });

  const diversosCat = categorias.find((c) => c.categoria === "Diversos");

  let mesAnterior = null;
  if (rowsMesAnterior && rowsMesAnterior.length) {
    const csP = agruparCupons(rowsMesAnterior);
    const fatP = round2(csP.reduce((s, c) => s + c.total, 0));
    mesAnterior = { faturamento: fatP, cupons: csP.length, ticket_medio: round2(fatP / csP.length) };
  }

  return {
    operacao: {
      faturamento,
      cupons: nCupons,
      ticket_medio: round2(faturamento / nCupons),
      ticket_mediano: round2(mediana(totaisCupom)),
      itens_por_compra_medio: round1(rows.length / nCupons),
      skus_distintos: skus.size,
      pareto_skus_80pct: pareto80,
      a_vista_pct: round1((aVista / faturamento) * 100),
    },
    baseline_semanal: porDiaSemana(cs),
    categorias,
    campanhas,
    canais,
    delivery_check: {
      cupons_com_taxa_entrega: cs.filter((c) => c.temTaxaEntrega).length,
      desses_que_sao_convenio: cs.filter((c) => c.temTaxaEntrega && !zeros(c.emp_id)).length,
      nota: "cupons com taxa de entrega NÃO são necessariamente delivery ao consumidor final",
    },
    concentracao_cliente: topN(cliMap, faturamento, 8),
    concentracao_convenio: topN(empMap, faturamento, 8),
    operadores,
    diversos: diversosCat ? { valor: diversosCat.faturamento, pct: round1(diversosCat.participacao_pct), cupons: diversosCat.cupons } : null,
    concorrencia: resumoConcorrencia(concorrencia),
    mes_anterior: mesAnterior,
  };
}

module.exports = { analiseProfunda };
