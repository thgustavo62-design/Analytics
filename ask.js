// Fase 11 — Ask Analytics. Pergunta estruturada → contexto AGREGADO (nunca a base bruta) →
// resposta no formato analista: conclusão + evidências + hipóteses + confiança + ação +
// o que monitorar.
//
// Determinístico por padrão. Se houver ANTHROPIC_API_KEY e config permitir, a IA recebe SÓ
// o pacote de números já calculados e é proibida de inventar qualquer valor — se ela falhar,
// cai no caminho determinístico.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { montarContexto } = require("./intelligence/contexto");
const intel = require("./intelligence");
const { investigar } = require("./intelligence/investigar");
const basket = require("./basket");
const mpa = require("./marketing-product-analytics");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "intelligence.json"), "utf8")).ask;
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function pacoteContexto(loja) {
  const ctx = montarContexto(loja);
  const wr = intel.warRoom(loja);
  const top = (ctx.analiseProdutos.produtos || []).slice(0, CFG.max_contexto_produtos).map((p) => ({
    descricao: p.descricao, ean: p.ean, categoria: p.categoria, classe: p.classe,
    opportunity: p.opportunity.score, tendencia: p.tendencia.rotulo, unid_30d: p.unidades[30],
    cobertura: p.cobertura_rotulo, margem_pct: p.margem_pct,
  }));
  return {
    loja, refDate: ctx.refDate, feeds: ctx.feeds,
    kpis: wr.kpis,
    categorias: ctx.categoriasTendencia,
    concorrencia_categorias_sob_pressao: [...ctx.concorrenciaCategorias],
    sinais_abertos: wr.threat_map.concat(wr.opportunity_map).slice(0, 20).map((s) => ({ codigo: s.codigo, classe: s.classe, tipo: s.tipo, titulo: s.titulo, prioridade: s.prioridade })),
    campanhas: ctx.eficienciaCampanhas.map((e) => e.erro ? { erro: e.erro } : ({ campanha: e.campanha, lift: e.metricas.DEMAND_LIFT_receita, veredito: e.veredito })),
    produtos: top,
  };
}

function respostaAnalista({ conclusao, evidencias, hipoteses, confianca, acao, monitorar, fonte }) {
  return {
    fonte: fonte || "deterministico",
    conclusao,
    evidencias: evidencias || [],
    hipoteses: hipoteses || [],
    confianca: Math.round((confianca ?? 0.4) * 100) / 100,
    acao_sugerida: acao || null,
    monitorar: monitorar || null,
  };
}

// ---- roteamento determinístico ----
function responderDeterministico(loja, pergunta, pack) {
  const q = norm(pergunta);

  if (/por que|porque|pq |motivo|explica/.test(q)) {
    const inv = investigar(loja, { pergunta });
    return respostaAnalista({
      conclusao: inv.conclusao,
      evidencias: inv.hipoteses.flatMap((h) => h.evidencias).slice(0, 8),
      hipoteses: inv.hipoteses.map((h) => ({ texto: h.texto, veredito: h.veredito, confianca: h.confianca })),
      confianca: inv.confianca,
      acao: "Abrir uma investigação formal (aba Investigações) se precisar de rastro.",
      monitorar: inv.assunto ? `${inv.assunto.tipo}: ${inv.assunto.ref}` : null,
    });
  }

  if (/o que (anunci|divulg|post)|recomend|o que vender|o que colocar/.test(q)) {
    const r = mpa.recomendados(loja, { limite: 8 });
    const itens = (r.produtos || []).slice(0, 6);
    return respostaAnalista({
      conclusao: itens.length ? `Priorizar ${itens.slice(0, 3).map((p) => p.descricao).join(", ")} — maior Opportunity Score sem bloqueio.` : "Nenhum produto claramente recomendável no período.",
      evidencias: itens.map((p) => ({ campo: "opportunity.score", valor: p.opportunity.score, fonte: "marketing-product-analytics", periodo: r.refDate, extra: p.descricao })),
      hipoteses: [],
      confianca: itens.length ? 0.6 : 0.2,
      acao: "Levar esses itens para a aba Marketing → Montar campanha.",
      monitorar: "conversão dos posts desses produtos na próxima semana",
    });
  }

  if (/combo|cesta|junto|leva junto/.test(q)) {
    const c = basket.combos(loja, { limite: 6 });
    const cs = c.combos || [];
    return respostaAnalista({
      conclusao: cs.length ? `Melhores combos por lift: ${cs.slice(0, 3).map((x) => `${x.produto_a.descricao} + ${x.produto_b.descricao} (${x.lift}×)`).join("; ")}.` : "Sem pares de cesta acima do corte de ruído ainda (precisa de mais histórico).",
      evidencias: cs.slice(0, 5).map((x) => ({ campo: "lift", valor: x.lift, fonte: "cesta_pares", periodo: c.janela ? `${c.janela.inicio}..${c.janela.fim}` : "", extra: `${x.produto_a.descricao} + ${x.produto_b.descricao}` })),
      confianca: cs.length ? 0.55 : 0.2,
      acao: "Montar PDV/post de combo com âncora + isca sugeridas.",
      monitorar: "itens por cupom (ticket) nas semanas seguintes",
    });
  }

  if (/campanha .*(vale|funciona|eficien|rende)|eficiencia|vale a pena a campanha/.test(q)) {
    const cs = pack.campanhas.filter((c) => !c.erro);
    return respostaAnalista({
      conclusao: cs.length ? cs.map((c) => `${c.campanha}: ${c.veredito} (lift ${c.lift}×)`).join(" · ") : "Sem amostra suficiente para avaliar as campanhas.",
      evidencias: cs.map((c) => ({ campo: "DEMAND_LIFT_receita", valor: c.lift, fonte: "campanhas.eficienciaCalendario", periodo: pack.refDate, extra: c.campanha })),
      confianca: cs.length ? 0.55 : 0.2,
      acao: "Ampliar as EXCELENTE/BOA; revisar sortimento e preço das FRACA.",
      monitorar: "DEMAND_LIFT das próximas 4 semanas",
    });
  }

  if (/estoque parado|encalhad|parad|nao gira|não gira/.test(q)) {
    const r = mpa.estoqueParado(loja);
    return respostaAnalista({
      conclusao: (r.produtos || []).length ? `${r.produtos.length} item(ns) ${r.modo === "sem_giro_proxy" ? "sem giro há 45d+" : "com cobertura de 'parado'"}.` : "Nada relevante parado no período.",
      evidencias: (r.produtos || []).slice(0, 6).map((p) => ({ campo: r.modo === "sem_giro_proxy" ? "dias_sem_venda" : "dias_cobertura", valor: r.modo === "sem_giro_proxy" ? p.dias_sem_venda : p.dias_cobertura, fonte: "marketing-product-analytics", periodo: r.refDate, extra: p.descricao })),
      confianca: r.feeds && r.feeds.estoque ? 0.6 : 0.35,
      acao: "Chamariz / combo / liquidação para esses itens.",
      monitorar: "giro semanal desses SKUs",
    });
  }

  // genérico: resumo do War Room
  const wr = pack;
  const p1 = wr.sinais_abertos[0];
  return respostaAnalista({
    conclusao: p1
      ? `Prioridade agora: ${p1.titulo} (${p1.codigo}, prioridade ${p1.prioridade}). Faturamento do mês ${wr.kpis.var_faturamento_pct == null ? "sem base de comparação" : (wr.kpis.var_faturamento_pct > 0 ? "+" : "") + wr.kpis.var_faturamento_pct + "% vs mês anterior"}.`
      : "Sem sinais abertos relevantes. Operação dentro do esperado.",
    evidencias: wr.sinais_abertos.slice(0, 6).map((s) => ({ campo: "sinal", valor: `${s.codigo} ${s.titulo}`, fonte: "intel_sinais", periodo: wr.refDate })),
    hipoteses: [],
    confianca: p1 ? 0.5 : 0.3,
    acao: p1 ? "Abrir a aba Intelligence → War Room e tratar a prioridade #1." : null,
    monitorar: "sinais abertos e faturamento semanal",
  });
}

async function perguntar(loja, { pergunta } = {}) {
  if (!pergunta || !pergunta.trim()) return { erro: "faça uma pergunta" };
  const pack = pacoteContexto(loja);
  const base = responderDeterministico(loja, pergunta, pack);

  const podeIA = CFG.usa_ia_se_tiver_chave && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!podeIA) return { loja, pergunta, refDate: pack.refDate, ...base, contexto_usado: resumoContexto(pack) };

  try {
    const AnthropicNS = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicNS.default || AnthropicNS;
    const client = new Anthropic();
    const system =
      "Você é um analista de marketing de varejo farmacêutico. Recebe um PACOTE JSON com números JÁ CALCULADOS " +
      "pelo backend. REGRAS ABSOLUTAS: (1) não invente nenhum número — só cite valores presentes no pacote; " +
      "(2) toda afirmação quantitativa deve vir com a evidência (campo + valor + período) tirada do pacote; " +
      "(3) se o pacote não tem o dado, diga 'não medido' — nunca estime. " +
      "Responda em JSON: {conclusao, evidencias:[{campo,valor,periodo,extra}], hipoteses:[{texto,veredito,confianca}], confianca (0-1), acao_sugerida, monitorar}. " +
      "Sem texto fora do JSON.";
    const user = `PERGUNTA: ${pergunta}\n\nPACOTE (só isto existe — não há mais dados):\n${JSON.stringify(pack)}\n\n` +
      `Rascunho determinístico do próprio sistema (pode reaproveitar/corrigir): ${JSON.stringify(base)}`;
    const resp = await client.messages.create({
      model: process.env.ASK_MODEL || "claude-sonnet-5",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }],
    });
    const txt = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const i = txt.indexOf("{");
    const j = txt.lastIndexOf("}");
    const parsed = JSON.parse(txt.slice(i, j + 1));
    return {
      loja, pergunta, refDate: pack.refDate,
      fonte: "ia",
      conclusao: parsed.conclusao || base.conclusao,
      evidencias: parsed.evidencias || base.evidencias,
      hipoteses: parsed.hipoteses || base.hipoteses,
      confianca: parsed.confianca ?? base.confianca,
      acao_sugerida: parsed.acao_sugerida || base.acao_sugerida,
      monitorar: parsed.monitorar || base.monitorar,
      contexto_usado: resumoContexto(pack),
    };
  } catch (e) {
    return { loja, pergunta, refDate: pack.refDate, ...base, fonte: "deterministico", nota_ia: "IA indisponível/erro — resposta determinística: " + e.message, contexto_usado: resumoContexto(pack) };
  }
}

function resumoContexto(pack) {
  return {
    refDate: pack.refDate, feeds: pack.feeds,
    n_produtos: pack.produtos.length, n_sinais: pack.sinais_abertos.length, n_categorias: pack.categorias.length,
  };
}

module.exports = { perguntar, pacoteContexto };
