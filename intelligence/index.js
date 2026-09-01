// Fases 5–12 — orquestrador da camada de inteligência.
//  - rodarDeteccao(loja): monta contexto → roda detectores → prioriza → persiste (dedupe,
//    reabre o que voltou, resolve o que sumiu). Chamado após cada ingestão de vendas.
//  - warRoom(loja): a foto para a tela escura (prioridade #1, ameaças, oportunidades,
//    situação por categoria, KPIs do mês).

const db = require("../db");
const { montarContexto } = require("./contexto");
const detectores = require("./detectores");
const { prioridade } = require("./priorizacao");
const { recomendarDecisoes } = require("./decisao");

function rodarDeteccao(loja, { persistir = true, contexto } = {}) {
  const ctx = contexto || montarContexto(loja);
  if (!ctx.refDate) return { loja, erro: "sem vendas para esta loja", sinais: [] };

  const { sinais, indisponivel } = detectores.rodarTodos(ctx);

  // prioridade: usa a primeira_vez já registrada, se o sinal existir
  const existentes = new Map(db.listSinais(loja, { limite: 500 }).map((s) => [s.dedupe_key, s]));
  for (const s of sinais) {
    const prev = existentes.get(s.dedupe_key);
    s.prioridade = prioridade(s, { primeira_vez: prev ? prev.primeira_vez : new Date().toISOString() });
  }
  sinais.sort((a, b) => b.prioridade - a.prioridade);

  const resultado = { loja, refDate: ctx.refDate, indisponivel, total: sinais.length, novos: 0, reabertos: 0, resolvidos: 0, sinais: [] };

  if (persistir) {
    const porTipo = new Map();
    for (const s of sinais) {
      const r = db.upsertSinal(loja, s);
      if (r.novo) resultado.novos++;
      if (r.reaberto) resultado.reabertos++;
      resultado.sinais.push({ ...s, id: r.id, codigo: r.codigo });
      if (!porTipo.has(s.tipo)) porTipo.set(s.tipo, []);
      porTipo.get(s.tipo).push(s.dedupe_key);
    }
    for (const [tipo, keys] of porTipo) {
      resultado.resolvidos += db.resolverSinaisAusentes(loja, [tipo], keys);
    }
    db.registrarEventoIntel(loja, "DETECCAO_RODOU", { payload: { total: sinais.length, novos: resultado.novos, refDate: ctx.refDate } });
  } else {
    resultado.sinais = sinais;
  }
  return resultado;
}

function warRoom(loja) {
  const ctx = montarContexto(loja);
  const abertos = db.listSinais(loja, { status: "aberto", limite: 200 });
  const observando = db.listSinais(loja, { status: "observando", limite: 50 });
  const todos = [...abertos, ...observando].sort((a, b) => b.prioridade - a.prioridade);

  const ameacas = todos.filter((s) => s.classe === "AMEACA");
  const oportunidades = todos.filter((s) => s.classe === "OPORTUNIDADE");
  const contradicoes = todos.filter((s) => s.classe === "CONTRADICAO");
  const sinais = todos.filter((s) => s.classe === "SINAL");

  const fh = ctx.historicoFaturamento || [];
  const mesAtual = fh[0] || null;
  const mesAnterior = fh.find((x, i) => i > 0 && !x.parcial) || fh[1] || null;
  const varFat = mesAtual && mesAnterior && mesAnterior.faturamento > 0
    ? Math.round(((mesAtual.faturamento - mesAnterior.faturamento) / mesAnterior.faturamento) * 1000) / 10
    : null;

  const situacaoCategorias = (ctx.categoriasTendencia || []).slice(0, 8).map((c) => ({
    categoria: c.categoria,
    receita_30d: c.receita_30d,
    var_pct: c.var_pct,
    estado: c.var_pct == null ? "s/ base" : c.var_pct <= -12 ? "CAINDO" : c.var_pct >= 15 ? "SUBINDO" : "ESTÁVEL",
    sob_pressao: ctx.concorrenciaCategorias.has(c.categoria),
  }));

  // "Palantir": cruza os sinais abertos entre si e propõe decisões
  let recomendacoes = [];
  try {
    recomendacoes = (recomendarDecisoes(loja).recomendacoes || []).slice(0, 8);
  } catch (e) {
    recomendacoes = [];
  }

  return {
    loja,
    refDate: ctx.refDate,
    gerado_em: db.nowIso(),
    feeds: ctx.feeds,
    kpis: {
      faturamento_mes: mesAtual ? mesAtual.faturamento : null,
      faturamento_mes_anterior: mesAnterior ? mesAnterior.faturamento : null,
      var_faturamento_pct: varFat,
      sinais_abertos: abertos.length,
      ameacas_abertas: ameacas.length,
      oportunidades_abertas: oportunidades.length,
      recomendacoes: recomendacoes.length,
    },
    prioridade_1: todos[0] || null,
    recomendacoes,
    threat_map: ameacas.slice(0, 12),
    opportunity_map: oportunidades.slice(0, 12),
    contradicoes,
    sinais: sinais.slice(0, 12),
    situacao_categorias: situacaoCategorias,
  };
}

module.exports = { rodarDeteccao, warRoom, montarContexto, recomendarDecisoes };
