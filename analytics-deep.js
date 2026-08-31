// Agregados "profundos" para o Motor de Análise Comercial: tudo que os Passos 1–8 do
// prompt precisam, calculado de forma DETERMINÍSTICA (o LLM interpreta, não faz conta).
// Entrada: linhas de vendas de UMA loja/mês (já com .categoria, e emp_id/cli_id se houver).

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

// agrupa por lançamento -> { total, itens, data, dow, usuario, emp_id, cli_id, temTaxaEntrega, temCampanha }
function cupons(rows, campanhaCat) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.lancamento)) {
      map.set(r.lancamento, {
        lanc: r.lancamento, total: 0, itens: 0, data: r.data, dow: weekdayOf(r.data),
        usuario: r.usuario || null, emp_id: r.emp_id || null, cli_id: r.cli_id || null,
        temTaxaEntrega: false, temCampanhaCat: false, aVista: 0, aPrazo: 0,
      });
    }
    const c = map.get(r.lancamento);
    c.total += r.valor_liquido;
    c.itens += 1;
    if (/TAXA DE ENTREGA/i.test(r.descricao)) c.temTaxaEntrega = true;
    if (campanhaCat && r.categoria === campanhaCat) c.temCampanhaCat = true;
    if (r.forma_pagto === "A VISTA") c.aVista += r.valor_liquido;
    else if (r.forma_pagto === "A PRAZO") c.aPrazo += r.valor_liquido;
  }
  return [...map.values()];
}

function porDiaSemana(cs) {
  // primeiro soma por data, depois estatística por dia da semana
  const porData = new Map();
  for (const c of cs) {
    if (!porData.has(c.data)) porData.set(c.data, { fat: 0, cupons: 0, dow: c.dow });
    const d = porData.get(c.data);
    d.fat += c.total;
    d.cupons += 1;
  }
  const buckets = {};
  for (const [, d] of porData) {
    (buckets[d.dow] = buckets[d.dow] || []).push(d);
  }
  return [1, 2, 3, 4, 5, 6, 0].map((dow) => {
    const dias = buckets[dow] || [];
    const fats = dias.map((x) => x.fat);
    const cups = dias.map((x) => x.cupons);
    const nCupons = cups.reduce((a, b) => a + b, 0);
    const fatTot = fats.reduce((a, b) => a + b, 0);
    return {
      dia_semana: dow,
      rotulo: WD[dow][0].toUpperCase() + WD[dow].slice(1),
      n: dias.length,
      faturamento_medio: round2(fats.length ? fatTot / fats.length : 0),
      mediana: round2(mediana(fats)),
      desvio_padrao: round2(desvioPadrao(fats)),
      cupons_medio: cups.length ? Math.round(nCupons / cups.length) : 0,
      ticket: round2(nCupons ? fatTot / nCupons : 0),
    };
  });
}

// participação da categoria de campanha no faturamento DO PRÓPRIO DIA (método correto
// de incrementalidade — neutraliza o dia da semana). Devolve média para um conjunto de dows.
function participacaoCategoriaPorDia(cs, campanhaCat, dows) {
  const porData = new Map();
  for (const c of cs) {
    if (!dows.includes(c.dow)) continue;
    if (!porData.has(c.data)) porData.set(c.data, { total: 0, cat: 0 });
    const d = porData.get(c.data);
    d.total += c.total;
    // aproximação: o cupom conta para a categoria se tiver ao menos 1 item dela
    if (c.temCampanhaCat) d.cat += c.total;
  }
  const parts = [...porData.values()].filter((d) => d.total > 0).map((d) => d.cat / d.total);
  return {
    dias: parts.length,
    participacao_media_pct: parts.length ? round1((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : null,
  };
}

function topN(map, total, n) {
  return [...map.entries()]
    .map(([k, v]) => ({ id: k, cupons: v.cupons, faturamento: round2(v.fat), pct: round1((v.fat / total) * 100) }))
    .sort((a, b) => b.faturamento - a.faturamento)
    .slice(0, n);
}

function analiseProfunda(rows, opts = {}) {
  const { lojaCfg = {}, rowsMesAnterior = null } = opts;
  const campanhaCat = lojaCfg.campanhaCategoria || null;
  const diasCampanha = Array.isArray(lojaCfg.diasCampanha) ? lojaCfg.diasCampanha : [];

  const cs = cupons(rows, campanhaCat);
  const faturamento = round2(cs.reduce((s, c) => s + c.total, 0));
  const nCupons = cs.length;
  const totaisCupom = cs.map((c) => c.total);
  const skus = new Set(rows.map((r) => r.barras || r.descricao));

  // Pareto: quantos SKUs fazem 80% do faturamento
  const porSku = new Map();
  for (const r of rows) {
    const k = r.descricao;
    porSku.set(k, (porSku.get(k) || 0) + r.valor_liquido);
  }
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

  // canais sem sobreposição: convênio (emp_id != 0) / delivery (taxa entrega, sem convênio) / balcão
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
  const cuponsTaxaEntrega = cs.filter((c) => c.temTaxaEntrega).length;
  const cuponsTaxaEConvenio = cs.filter((c) => c.temTaxaEntrega && !zeros(c.emp_id)).length;

  // concentração por cliente e por convênio (empresa)
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

  // campanha própria — incrementalidade intradiária com 2 baselines
  let campanha = null;
  if (diasCampanha.length && campanhaCat) {
    const outros = [1, 2, 3, 4, 5, 6, 0].filter((d) => !diasCampanha.includes(d));
    // baseline 1: dias úteis fora da campanha; baseline 2: fim de semana (5=sex,6=sáb,0=dom)
    const base1 = outros.filter((d) => d >= 1 && d <= 4);
    const base2 = outros.filter((d) => d === 5 || d === 6 || d === 0);
    campanha = {
      categoria: campanhaCat,
      dias_semana: diasCampanha,
      promo: participacaoCategoriaPorDia(cs, campanhaCat, diasCampanha),
      baselines: [
        { nome: "dias úteis fora da campanha", ...participacaoCategoriaPorDia(cs, campanhaCat, base1.length ? base1 : outros) },
        { nome: "sexta a domingo", ...participacaoCategoriaPorDia(cs, campanhaCat, base2.length ? base2 : outros) },
      ],
    };
  }

  const diversosCat = categorias.find((c) => c.categoria === "Diversos");

  let mesAnterior = null;
  if (rowsMesAnterior && rowsMesAnterior.length) {
    const csP = cupons(rowsMesAnterior, null);
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
    campanha,
    canais,
    delivery_check: {
      cupons_com_taxa_entrega: cuponsTaxaEntrega,
      desses_que_sao_convenio: cuponsTaxaEConvenio,
      nota: "cupons com taxa de entrega NÃO são necessariamente delivery ao consumidor final",
    },
    concentracao_cliente: topN(cliMap, faturamento, 8),
    concentracao_convenio: topN(empMap, faturamento, 8),
    operadores,
    diversos: diversosCat ? { valor: diversosCat.faturamento, pct: round1(diversosCat.participacao_pct), cupons: diversosCat.cupons } : null,
    mes_anterior: mesAnterior,
  };
}

module.exports = { analiseProfunda };
