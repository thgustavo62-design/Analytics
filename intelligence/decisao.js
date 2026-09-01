// "Modelo Palantir": cruza os sinais abertos (que já vêm com evidência) entre si e com o
// contexto determinístico, e propõe DECISÕES — ação + efeito esperado + a cadeia de
// evidências que sustenta. Nada de IA: são playbooks sobre combinações de sinais.
//
// A saída alimenta o War Room, o site publicado e pré-preenche o formulário de decisão
// (POST /api/intelligence/:loja/decisions).

const db = require("../db");
const { montarContexto } = require("./contexto");
const campanhas = require("../campanhas");

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// categorias que um sinal "toca" (a própria + as das campanhas, quando o sinal é de campanha)
function categoriasDoSinal(s, lojaCfg) {
  if (s.entidade_tipo === "categoria") return [s.entidade_ref];
  if (s.entidade_tipo === "campanha") {
    const c = (lojaCfg.campanhas || []).find((x) => x.nome === s.entidade_ref);
    return (c && c.categorias) || [];
  }
  return [];
}

function ev(campo, valor, fonte, periodo) {
  return { campo, valor: valor == null ? null : String(valor), fonte, periodo: periodo || null };
}

// ---------------------------------------------------------------------------

function recomendarDecisoes(loja) {
  const ctx = montarContexto(loja);
  const abertos = [...db.listSinais(loja, { status: "aberto", limite: 300 }), ...db.listSinais(loja, { status: "observando", limite: 80 })];
  if (!abertos.length) return { loja, refDate: ctx.refDate, recomendacoes: [] };

  const lojaCfg = ctx.lojaCfg || {};
  const porTipo = {};
  for (const s of abertos) (porTipo[s.tipo] = porTipo[s.tipo] || []).push(s);
  const tem = (t) => (porTipo[t] || []);

  // resolve entidade_ref de produto (EAN) para a descrição legível
  const nomeProd = new Map();
  for (const p of ctx.analiseProdutos.produtos || []) {
    if (p.ean) nomeProd.set(p.ean, p.descricao);
    nomeProd.set(p.descricao, p.descricao);
  }
  const rotulo = (s) => (s.entidade_tipo === "produto" ? (nomeProd.get(s.entidade_ref) || s.entidade_ref) : s.entidade_ref);

  // índice: categoria -> sinais que a tocam
  const porCategoria = new Map();
  for (const s of abertos) {
    for (const cat of categoriasDoSinal(s, lojaCfg)) {
      if (!porCategoria.has(cat)) porCategoria.set(cat, []);
      porCategoria.get(cat).push(s);
    }
  }

  const recs = [];
  const usados = new Set(); // ids de sinal já "consumidos" por uma recomendação de cluster
  const marcar = (arr) => arr.forEach((s) => usados.add(s.id));
  const push = (r) => {
    r.prioridade = Math.min(100, Math.round(r.prioridade * 10) / 10);
    r.sinais_codigos = r.sinais.map((s) => s.codigo);
    r.sinais = r.sinais.map((s) => s.id);
    recs.push(r);
  };

  // ---- Playbook 1: DEFENDER CATEGORIA (queda + ataque de preço na MESMA categoria) ----
  for (const [cat, sigs] of porCategoria) {
    const decl = sigs.find((s) => s.tipo === "CATEGORY_DECLINE");
    const atk = sigs.find((s) => s.tipo === "COMPETITOR_PRICE_ATTACK");
    if (decl && atk) {
      const cluster = [decl, atk];
      const builder = safe(() => campanhas.campaignBuilder(loja, { objetivo: "DEFENDER_CONCORRENCIA", categorias: [cat] }));
      const chamariz = builder && builder.elenco && builder.elenco.CHAMARIZ ? builder.elenco.CHAMARIZ.slice(0, 3).map((x) => x.descricao) : [];
      const conc = ctx.concorrencia.porCategoria.get(cat);
      push({
        tipo: "DEFENDER_CATEGORIA",
        titulo: `Defender ${cat} agora — está caindo E sob ataque de preço`,
        entidade: { tipo: "categoria", ref: cat },
        prioridade: Math.max(decl.prioridade, atk.prioridade) + 12,
        confianca: Math.min(0.85, (decl.confianca + atk.confianca) / 2 + 0.1),
        sinais: cluster,
        acao:
          `Montar campanha de defesa em ${cat}: ` +
          (chamariz.length ? `chamariz ${chamariz.join(", ")}; ` : "") +
          `cobrir o preço do concorrente nos ${conc ? conc.abaixo : "N"} itens abaixo do nosso.`,
        efeito_esperado: `Estancar a queda de ${cat} (hoje ${decl.resumo || "receita em baixa"}) e não perder o cliente pro preço.`,
        evidencias: [
          ev("variacao_categoria", (decl.evidencias && (decl.evidencias.find((e) => e.campo === "variacao_pct") || {}).valor) || "queda", "CATEGORY_DECLINE", ctx.refDate),
          ev("ofertas_abaixo_do_nosso", conc ? conc.abaixo : null, "COMPETITOR_PRICE_ATTACK / concorrencia_ofertas", ctx.concorrencia.periodo),
        ],
      });
      marcar(cluster);
    }
  }

  // ---- Playbook 2: CAMPANHA FALTANDO ESTOQUE (campanha fraca + ruptura na categoria dela) ----
  for (const camp of tem("CAMPAIGN_UNDERPERFORMANCE")) {
    if (usados.has(camp.id)) continue;
    const cats = new Set(categoriasDoSinal(camp, lojaCfg));
    const rupt = tem("STOCK_RISK").filter((s) => {
      const p = (ctx.analiseProdutos.produtos || []).find((x) => (x.ean || x.descricao) === s.entidade_ref);
      return p && cats.has(p.categoria);
    });
    if (rupt.length) {
      const cluster = [camp, ...rupt];
      push({
        tipo: "CAMPANHA_SEM_ESTOQUE",
        titulo: `Campanha "${camp.entidade_ref}" rende pouco porque falta estoque`,
        entidade: { tipo: "campanha", ref: camp.entidade_ref },
        prioridade: camp.prioridade + 10,
        confianca: 0.6,
        sinais: cluster,
        acao: `Repor ${rupt.slice(0, 5).map((s) => nomeCurto(s.titulo)).join(", ")} ANTES de colocar verba na campanha "${camp.entidade_ref}".`,
        efeito_esperado: `A campanha deixa de "vender o que não tem"; o DEMAND_LIFT tende a subir sem gastar mais em mídia.`,
        evidencias: [
          ev("DEMAND_LIFT", (camp.evidencias && (camp.evidencias.find((e) => /LIFT/i.test(e.campo)) || {}).valor) || "abaixo do aceitável", "CAMPAIGN_UNDERPERFORMANCE", ctx.refDate),
          ...rupt.slice(0, 4).map((s) => ev("ruptura", nomeCurto(s.titulo), "STOCK_RISK", ctx.refDate)),
        ],
      });
      marcar(cluster);
    }
  }

  // ---- Playbook 3: APROVEITAR A ALTA (categoria/produto subindo + sem campanha fixa) ----
  const altas = [
    ...tem("CATEGORY_GROWTH"),
    ...tem("DEMAND_ANOMALY").filter((s) => s.classe === "OPORTUNIDADE"),
    ...tem("MARKETING_OPPORTUNITY"),
  ].filter((s) => !usados.has(s.id));
  const porAlvo = new Map();
  for (const s of altas) {
    const alvo = (s.entidade_tipo || "") + ":" + norm(categoriasDoSinal(s, lojaCfg)[0] || s.entidade_ref);
    if (!porAlvo.has(alvo)) porAlvo.set(alvo, []);
    porAlvo.get(alvo).push(s);
  }
  const clustersAlta = [...porAlvo.values()]
    .map((sigs) => ({ sigs, top: sigs.slice().sort((a, b) => b.prioridade - a.prioridade)[0] }))
    .sort((a, b) => (b.top.prioridade + (b.sigs.length > 1 ? 8 : 0)) - (a.top.prioridade + (a.sigs.length > 1 ? 8 : 0)));
  for (const { sigs, top } of clustersAlta.slice(0, 3)) {
    const bonus = sigs.length > 1 ? 8 : 0;
    push({
      tipo: "APROVEITAR_ALTA",
      titulo: `Anunciar "${rotulo(top)}" enquanto está em alta`,
      entidade: { tipo: top.entidade_tipo, ref: rotulo(top) },
      prioridade: top.prioridade + bonus,
      confianca: Math.min(0.8, top.confianca + (sigs.length > 1 ? 0.15 : 0)),
      sinais: sigs,
      acao: `Colocar "${rotulo(top)}" na pauta dos próximos 7 dias (o motor editorial já sugere ângulo/CTA). Testar 1 post de oferta.`,
      efeito_esperado: `Surfar a demanda que já subiu antes que esfrie; ${sigs.length > 1 ? "vários sinais concordam" : "sinal isolado"}.`,
      evidencias: sigs.slice(0, 4).map((s) => ev(s.tipo, s.titulo, "detectores", ctx.refDate)),
    });
    marcar(sigs);
  }
  const restoAlta = clustersAlta.slice(3).flatMap((c) => c.sigs).filter((s) => !usados.has(s.id));
  if (restoAlta.length >= 3) {
    push({
      tipo: "APROVEITAR_ALTA",
      titulo: `Mais ${restoAlta.length} produtos/categorias em alta sem campanha`,
      entidade: { tipo: "loja", ref: loja },
      prioridade: 52,
      confianca: 0.55,
      sinais: restoAlta,
      acao: `Revisar a lista de "Recomendados" no Marketing e distribuir esses itens na pauta da semana.`,
      efeito_esperado: `Não deixar demanda crescente sem comunicação.`,
      evidencias: restoAlta.slice(0, 6).map((s) => ev(s.tipo, `${rotulo(s)}: ${s.titulo}`, "detectores", ctx.refDate)),
    });
    marcar(restoAlta);
  }

  // ---- Playbook 4: DESOVAR ENCALHE COM COMBO (estoque parado + par de cesta com HERO) ----
  const parado = tem("STAGNANT_STOCK").filter((s) => !usados.has(s.id));
  const cross = tem("CROSS_SELL_OPPORTUNITY");
  if (parado.length && cross.length) {
    const cluster = [parado[0], cross[0]];
    push({
      tipo: "DESOVAR_COMBO",
      titulo: `Desovar encalhe puxando por um campeão (combo de cesta)`,
      entidade: { tipo: "loja", ref: loja },
      prioridade: Math.max(parado[0].prioridade, cross[0].prioridade) + 6,
      confianca: 0.55,
      sinais: cluster,
      acao: `Montar combo no PDV/post: item parado + o HERO da cesta (${nomeCurto(cross[0].titulo)}). Desconto só no encalhe.`,
      efeito_esperado: `Gira o capital parado sem sacrificar margem do campeão; usa uma relação de compra que já existe (lift alto).`,
      evidencias: [
        ev("encalhe", parado[0].resumo || parado[0].titulo, "STAGNANT_STOCK", ctx.refDate),
        ev("cesta", cross[0].titulo, "CROSS_SELL_OPPORTUNITY / cesta_pares", ctx.refDate),
      ],
    });
    marcar(cluster);
  }

  // ---- Playbook 5: CONTRADIÇÃO -> revisar antes de agir ----
  for (const c of tem("CONTRADICTION").filter((s) => !usados.has(s.id))) {
    push({
      tipo: "REVISAR_DADO",
      titulo: `Revisar antes de decidir: ${c.titulo}`,
      entidade: { tipo: c.entidade_tipo, ref: c.entidade_ref },
      prioridade: c.prioridade + 5,
      confianca: c.confianca,
      sinais: [c],
      acao: `Conferir cadastro/feed do que a contradição aponta antes de qualquer campanha nessa frente.`,
      efeito_esperado: `Evita decidir em cima de dado inconsistente.`,
      evidencias: (c.evidencias || []).slice(0, 4),
    });
    usados.add(c.id);
  }

  // ---- Sobras: sinais de alta prioridade que não entraram em nenhum cluster ----
  for (const s of abertos.filter((x) => !usados.has(x.id) && x.prioridade >= 55).sort((a, b) => b.prioridade - a.prioridade).slice(0, 6)) {
    push({
      tipo: "SINAL_ISOLADO",
      titulo: s.titulo,
      entidade: { tipo: s.entidade_tipo, ref: s.entidade_ref },
      prioridade: s.prioridade,
      confianca: s.confianca,
      sinais: [s],
      acao: acaoPadrao(s),
      efeito_esperado: s.resumo || "—",
      evidencias: (db.getSinal(s.id).evidencias || []).slice(0, 4),
    });
  }

  recs.sort((a, b) => b.prioridade - a.prioridade);
  recs.forEach((r, i) => { r.codigo = "REC-" + String(i + 1).padStart(3, "0"); });
  return { loja, refDate: ctx.refDate, gerado_em: db.nowIso(), total: recs.length, recomendacoes: recs };
}

function acaoPadrao(s) {
  return ({
    STOCK_RISK: "Repor com urgência; não anunciar até normalizar a cobertura.",
    STAGNANT_STOCK: "Chamariz / combo / liquidação para recuperar capital.",
    CATEGORY_DECLINE: "Investigar a causa ('Por quê?') e montar campanha de recuperação.",
    CATEGORY_GROWTH: "Reforçar sortimento e comunicação enquanto sobe.",
    COMPETITOR_PRICE_ATTACK: "Cobrir o preço nos itens que importam; comunicar 'melhor preço'.",
    CAMPAIGN_OVERPERFORMANCE: "Ampliar verba/sortimento e testar mais dias.",
    CAMPAIGN_UNDERPERFORMANCE: "Revisar preço e sortimento da campanha; conferir estoque.",
    DEMAND_ANOMALY: "Confirmar a causa e ajustar compra/pauta.",
    CREATIVE_FATIGUE: "Renovar criativos/formatos no Instagram.",
    MARKETING_OPPORTUNITY: "Levar para a pauta e para o Campaign Builder.",
    CROSS_SELL_OPPORTUNITY: "Montar combo/PDV com o par.",
  })[s.tipo] || "Analisar e decidir.";
}
function nomeCurto(t) { return String(t || "").replace(/^.*?:\s*/, "").slice(0, 40); }
function safe(fn) { try { return fn(); } catch { return null; } }

module.exports = { recomendarDecisoes };
