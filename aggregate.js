// Agrega as linhas de venda nas estruturas que as funções de render do painel esperam.
// Nada de LLM: só soma e conta. Toda entrada aqui já é de uma única loja/período.

const { classificar } = require("./classify");

const CORES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];
const WEEKDAYS = [
  { js: 1, label: "Segunda" },
  { js: 2, label: "Terça" },
  { js: 3, label: "Quarta" },
  { js: 4, label: "Quinta" },
  { js: 5, label: "Sexta" },
  { js: 6, label: "Sábado" },
  { js: 0, label: "Domingo" },
];

const EXCLUIR_DO_RANKING = new Set(["DIVERSOS", "TAXA DE ENTREGA"]);

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function labelCategoria(cat) {
  return cat.includes("/") ? cat.replace("/", " / ") : cat;
}

function weekdayOf(isoDate) {
  return new Date(isoDate + "T12:00:00").getDay();
}

/**
 * @param {Array} rows  linhas de vendas_transacoes (já com .categoria) OU do parser (sem)
 * @param {{ lastDay?: string, lastDayPartial?: boolean, diasCampanha?: number[] }} opts
 */
function aggregate(rows, opts = {}) {
  const { lastDay = null, lastDayPartial = false } = opts;

  // garante categoria
  const items = rows.map((r) => ({
    ...r,
    categoria: r.categoria || classificar(r.descricao),
  }));

  const faturamento = round2(items.reduce((s, r) => s + r.valor_liquido, 0));
  const lancamentos = new Set(items.map((r) => r.lancamento));
  const vendas = lancamentos.size;
  const itens = items.length;
  const aVista = round2(items.filter((r) => r.forma_pagto === "A VISTA").reduce((s, r) => s + r.valor_liquido, 0));
  const aPrazo = round2(faturamento - aVista);

  // --- série diária ---
  const porDia = new Map(); // 'AAAA-MM-DD' -> { v, lanc:Set }
  for (const r of items) {
    if (!porDia.has(r.data)) porDia.set(r.data, { v: 0, lanc: new Set() });
    const e = porDia.get(r.data);
    e.v += r.valor_liquido;
    e.lanc.add(r.lancamento);
  }
  const daily = [...porDia.keys()]
    .sort()
    .map((data) => ({
      data,
      d: parseInt(data.slice(8, 10), 10),
      v: round2(porDia.get(data).v),
      n: porDia.get(data).lanc.size,
      parcial: lastDayPartial && data === lastDay,
    }));

  const diasCompletos = daily.filter((x) => !x.parcial);
  const mediaDiaria = diasCompletos.length
    ? round2(diasCompletos.reduce((s, x) => s + x.v, 0) / diasCompletos.length)
    : 0;

  // --- por dia da semana (inclui todos os dias, como no painel de referência) ---
  const wAcc = new Map(WEEKDAYS.map((w) => [w.js, { v: 0, lanc: new Set() }]));
  for (const r of items) {
    const e = wAcc.get(weekdayOf(r.data));
    e.v += r.valor_liquido;
    e.lanc.add(r.lancamento);
  }
  const weekday = WEEKDAYS.map((w) => ({
    label: w.label,
    js: w.js,
    v: round2(wAcc.get(w.js).v),
    n: wAcc.get(w.js).lanc.size,
  }));

  // --- categorias ---
  const catAcc = new Map();
  for (const r of items) catAcc.set(r.categoria, (catAcc.get(r.categoria) || 0) + r.valor_liquido);
  const categories = [...catAcc.entries()]
    .map(([cat, v]) => ({ label: labelCategoria(cat), catRaw: cat, v: round2(v) }))
    .sort((a, b) => b.v - a.v)
    .map((c, i) => ({ ...c, color: CORES[i % CORES.length] }));

  const diversosV = round2(catAcc.get("Diversos") || 0);
  const diversosPct = faturamento ? diversosV / faturamento : 0;

  // --- top produtos ---
  const prodAcc = new Map(); // descricao -> { v, cat, n:Set }
  for (const r of items) {
    if (!prodAcc.has(r.descricao)) prodAcc.set(r.descricao, { v: 0, cat: r.categoria, lanc: new Set() });
    const e = prodAcc.get(r.descricao);
    e.v += r.valor_liquido;
    e.lanc.add(r.lancamento);
  }
  const allProducts = [...prodAcc.entries()]
    .map(([name, e]) => ({ name, cat: labelCategoria(e.cat), catRaw: e.cat, v: round2(e.v), n: e.lanc.size }))
    .sort((a, b) => b.v - a.v);

  const topProducts = allProducts.filter((p) => !EXCLUIR_DO_RANKING.has(p.name.toUpperCase())).slice(0, 15);

  const extras = {};
  for (const nome of EXCLUIR_DO_RANKING) {
    const hit = allProducts.find((p) => p.name.toUpperCase() === nome);
    if (hit) extras[nome === "DIVERSOS" ? "diversos" : "taxaEntrega"] = { name: hit.name, v: hit.v, n: hit.n };
  }

  // preço médio praticado por produto (para o cruzamento com concorrência)
  const precoMedioPorProduto = [...prodAcc.entries()].map(([name, e]) => {
    const linhas = items.filter((r) => r.descricao === name);
    const qtd = linhas.reduce((s, r) => s + (r.quantidade || 0), 0);
    return { name, precoMedio: qtd > 0 ? round2(e.v / qtd) : null };
  });

  return {
    kpis: {
      faturamento,
      ticketMedio: vendas ? round2(faturamento / vendas) : 0,
      vendas,
      itens,
      aVistaValor: aVista,
      aVistaPct: faturamento ? round2((aVista / faturamento) * 100) : 0,
      aPrazoValor: aPrazo,
      aPrazoPct: faturamento ? round2((aPrazo / faturamento) * 100) : 0,
      mediaDiaria,
    },
    daily,
    weekday,
    categories,
    topProducts,
    extras,
    diversos: { valor: diversosV, pct: round2(diversosPct * 1000) / 1000 },
    precoMedioPorProduto,
  };
}

module.exports = { aggregate, round2, labelCategoria };
