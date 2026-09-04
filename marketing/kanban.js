// Quadro Kanban de marketing + banco de ideias.
//
//   quadro(loja)                 -> colunas ideia / fazer / fazendo / feito + contagens
//   criar / atualizar / mover / remover
//   sugestoes(loja, opts)        -> ideias novas, cada uma amarrada a uma JOGADA DE MULTINACIONAL
//                                   (config/playbook-multinacionais.json) que o dado da loja disparou
//
// Determinístico: a sugestão só aparece quando o gatilho existe nos dados, e vem com a evidência.

const fs = require("fs");
const path = require("path");
const db = require("../db");
const mpa = require("../marketing-product-analytics");
const { categoriaCanonica } = require("../categorias");

const PB = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "playbook-multinacionais.json"), "utf8")); }
  catch { return { jogadas: [] }; }
})();
const JOGADAS = PB.jogadas || [];
const JOGADA_POR_ID = new Map(JOGADAS.map((j) => [j.id, j]));

const COLUNAS = ["ideia", "fazer", "fazendo", "feito"];
const COLUNA_ROTULO = { ideia: "Ideias", fazer: "A fazer", fazendo: "Executando", feito: "Entregue" };
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const brl = (n) => "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- CRUD ----------

function listarTarefas(loja) {
  return db.db.prepare(
    "SELECT * FROM mkt_tarefas WHERE loja IS NULL OR loja = ? ORDER BY coluna, ordem, id"
  ).all(loja);
}

function quadro(loja) {
  if (!db.LOJAS_VALIDAS.includes(loja)) return { erro: `loja inválida: ${loja}` };
  const todas = listarTarefas(loja).map(enriquecer);
  const colunas = COLUNAS.map((c) => ({
    id: c, rotulo: COLUNA_ROTULO[c],
    tarefas: todas.filter((t) => t.coluna === c),
  }));
  const feitas = todas.filter((t) => t.coluna === "feito");
  return {
    loja,
    colunas,
    totais: Object.fromEntries(colunas.map((c) => [c.id, c.tarefas.length])),
    entregues_30d: feitas.filter((t) => t.entregue_em && (Date.now() - Date.parse(t.entregue_em)) < 30 * 864e5).length,
    playbook_total: JOGADAS.length,
  };
}

function enriquecer(t) {
  const j = t.playbook ? JOGADA_POR_ID.get(t.playbook) : null;
  return {
    ...t,
    jogada: j ? { id: j.id, empresa: j.empresa, jogada: j.jogada, por_que_funciona: j.por_que_funciona } : null,
  };
}

function criar(loja, dados = {}) {
  const titulo = String(dados.titulo || "").trim();
  if (!titulo) return { erro: "título é obrigatório" };
  const coluna = COLUNAS.includes(dados.coluna) ? dados.coluna : "ideia";
  const ordem = (db.db.prepare("SELECT COALESCE(MAX(ordem), 0) m FROM mkt_tarefas WHERE coluna = ?").get(coluna).m || 0) + 1;
  const info = db.db.prepare(
    `INSERT INTO mkt_tarefas (loja, titulo, descricao, coluna, prioridade, categoria, origem, playbook, impacto_esperado, ordem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dados.loja_todas ? null : loja,
    titulo,
    dados.descricao || null,
    coluna,
    dados.prioridade || null,
    dados.categoria ? categoriaCanonica(dados.categoria) : null,
    dados.origem || "manual",
    dados.playbook && JOGADA_POR_ID.has(dados.playbook) ? dados.playbook : null,
    dados.impacto_esperado || null,
    ordem
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function atualizar(id, campos = {}) {
  const atual = db.db.prepare("SELECT * FROM mkt_tarefas WHERE id = ?").get(id);
  if (!atual) return { erro: "tarefa não encontrada" };
  const sets = [];
  const vals = [];
  const permitido = ["titulo", "descricao", "coluna", "prioridade", "categoria", "impacto_esperado", "resultado", "ordem"];
  for (const k of permitido) {
    if (campos[k] === undefined) continue;
    if (k === "coluna" && !COLUNAS.includes(campos[k])) continue;
    sets.push(`${k} = ?`);
    vals.push(k === "categoria" && campos[k] ? categoriaCanonica(campos[k]) : campos[k]);
  }
  if (!sets.length) return { erro: "nada para atualizar" };
  // entrou em "feito" agora -> carimba a entrega; saiu de "feito" -> limpa
  if (campos.coluna === "feito" && atual.coluna !== "feito") { sets.push("entregue_em = datetime('now')"); }
  if (campos.coluna && campos.coluna !== "feito" && atual.coluna === "feito") { sets.push("entregue_em = NULL"); }
  sets.push("atualizado_em = datetime('now')");
  db.db.prepare(`UPDATE mkt_tarefas SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return { ok: true, id: Number(id) };
}

function remover(id) {
  const info = db.db.prepare("DELETE FROM mkt_tarefas WHERE id = ?").run(id);
  return info.changes ? { ok: true } : { erro: "tarefa não encontrada" };
}

// ---------- sugestões (dado da loja x jogada de multinacional) ----------

function contextoDaLoja(loja, opts = {}) {
  const a = mpa.analisarProdutos(loja, opts);
  if (a.erro) return { erro: a.erro };
  const prods = a.produtos || [];
  const catsAtaque = opts.concorrenciaCategorias instanceof Set ? [...opts.concorrenciaCategorias] : [];

  const parados = prods
    .filter((p) => (p.cobertura_rotulo === "PARADO" || p.cobertura_infinita) && p.custo_atual != null && p.estoque_atual > 0)
    .map((p) => ({ ...p, capital: p.custo_atual * p.estoque_atual }))
    .sort((x, y) => y.capital - x.capital);

  const rupturas = prods
    .filter((p) => p.cobertura_rotulo === "RUPTURA" && (p.receita && p.receita.d30) >= 80)
    .sort((x, y) => y.receita.d30 - x.receita.d30);

  const margemAltaSemGiro = prods
    .filter((p) => p.margem_pct != null && p.margem_pct >= 0.45 && (p.venda_media_diaria && p.venda_media_diaria.d30) < 0.3 && p.abc !== "C")
    .sort((x, y) => (y.margem_pct || 0) - (x.margem_pct || 0));

  const recorrentes = prods
    .filter((p) => (p.cupons && p.cupons.d30) >= 8 && ["Fraldas", "Leite Infantil", "Medicamento", "Bebê"].includes(categoriaCanonica(p.categoria)))
    .sort((x, y) => (y.cupons.d30 || 0) - (x.cupons.d30 || 0));

  // LÊ os pares já materializados (não recalcula a cesta — isso é caro e roda na ingestão).
  // lift alto E que aconteça de verdade: ordena pelo nº de cupons do par, não pelo lift
  // (lift gigante costuma ser par raro, que só apareceu junto uma vez).
  let paresCesta = [];
  try {
    const b = db.getCestaPares(loja, { limite: 400 });
    paresCesta = (b.pares || [])
      .filter((p) => p.lift >= 2)
      .sort((x, y) => (y.cupons_ab || 0) - (x.cupons_ab || 0))
      .slice(0, 5);
  } catch (e) { /* sem cesta ainda */ }

  let fadiga = [];
  try { fadiga = (require("./padroes-mkt").fadigaProdutos(loja) || {}).produtos || []; } catch (e) {}

  let subcomunicando = [];
  try {
    const c = require("../concorrencia-analise").analisarConcorrencia(loja);
    subcomunicando = ((c.share_promocoes || {}).por_categoria || []).filter((x) => /subcomunic/i.test(x.veredito || "")).map((x) => x.categoria);
  } catch (e) {}

  return {
    refDate: a.refDate,
    catsAtaque,
    parados: parados.slice(0, 5),
    capital_parado: r2(parados.reduce((s, p) => s + p.capital, 0)),
    rupturas: rupturas.slice(0, 5),
    margemAltaSemGiro: margemAltaSemGiro.slice(0, 5),
    recorrentes: recorrentes.slice(0, 5),
    paresCesta,
    fadiga: fadiga.slice(0, 5),
    subcomunicando,
  };
}

// dado o gatilho, devolve { vale, evidencia, alvo } com nomes concretos da loja
function avaliarGatilho(g, ctx) {
  switch (g) {
    case "sempre":
      return { vale: true, evidencia: null, alvo: null };
    case "categoria_sob_ataque":
      return ctx.catsAtaque.length
        ? { vale: true, evidencia: `concorrente abaixo do nosso preço em: ${ctx.catsAtaque.join(", ")}`, alvo: ctx.catsAtaque[0] }
        : { vale: false };
    case "estoque_parado":
      return ctx.parados.length
        ? { vale: true, evidencia: `${brl(ctx.capital_parado)} parados — maior: ${ctx.parados[0].descricao} (${brl(ctx.parados[0].capital)})`, alvo: ctx.parados[0].descricao }
        : { vale: false };
    case "ruptura":
      return ctx.rupturas.length
        ? { vale: true, evidencia: `${ctx.rupturas.length} produto(s) com venda relevante em risco de ruptura — ex.: ${ctx.rupturas[0].descricao}`, alvo: ctx.rupturas[0].descricao }
        : { vale: false };
    case "margem_alta_sem_giro":
      return ctx.margemAltaSemGiro.length
        ? { vale: true, evidencia: `${ctx.margemAltaSemGiro.length} item(ns) com margem ≥45% e giro baixo — ex.: ${ctx.margemAltaSemGiro[0].descricao} (${Math.round(ctx.margemAltaSemGiro[0].margem_pct * 100)}%)`, alvo: ctx.margemAltaSemGiro[0].descricao }
        : { vale: false };
    case "produto_recorrente":
      return ctx.recorrentes.length
        ? { vale: true, evidencia: `recompra previsível — ex.: ${ctx.recorrentes[0].descricao} (${ctx.recorrentes[0].cupons.d30} cupons/30d)`, alvo: ctx.recorrentes[0].descricao }
        : { vale: false };
    case "cesta_lift_alto":
      return ctx.paresCesta.length
        ? { vale: true, evidencia: `par de cesta com lift ${ctx.paresCesta[0].lift}×: ${ctx.paresCesta[0].desc_a} + ${ctx.paresCesta[0].desc_b}`, alvo: `${ctx.paresCesta[0].desc_a} + ${ctx.paresCesta[0].desc_b}` }
        : { vale: false };
    case "campanha_em_fadiga":
      return ctx.fadiga.length
        ? { vale: true, evidencia: `${ctx.fadiga.length} produto(s) perdendo força em campanha — ex.: ${ctx.fadiga[0].descricao} (-${ctx.fadiga[0].queda_pct}%)`, alvo: ctx.fadiga[0].descricao }
        : { vale: false };
    case "subcomunicando":
      return ctx.subcomunicando.length
        ? { vale: true, evidencia: `categoria subcomunicada vs concorrência: ${ctx.subcomunicando.join(", ")}`, alvo: ctx.subcomunicando[0] }
        : { vale: false };
    default:
      return { vale: false };
  }
}

function sugestoes(loja, opts = {}) {
  if (!db.LOJAS_VALIDAS.includes(loja)) return { erro: `loja inválida: ${loja}` };
  const ctx = contextoDaLoja(loja, opts);
  if (ctx.erro) return { erro: ctx.erro, sugestoes: [] };

  // não sugerir o que já está no quadro (mesma jogada)
  const jaNoQuadro = new Set(listarTarefas(loja).map((t) => t.playbook).filter(Boolean));

  const out = [];
  for (const j of JOGADAS) {
    const g = avaliarGatilho(j.gatilho, ctx);
    if (!g.vale) continue;
    out.push({
      playbook: j.id,
      empresa: j.empresa,
      jogada: j.jogada,
      o_que_e: j.o_que_e,
      por_que_funciona: j.por_que_funciona,
      titulo: j.jogada,
      descricao: j.como_adaptar,
      gatilho: j.gatilho,
      evidencia: g.evidencia,
      alvo: g.alvo,
      esforco: j.esforco,
      impacto: j.impacto,
      ja_no_quadro: jaNoQuadro.has(j.id),
    });
  }
  // com evidência concreta primeiro, depois por impacto
  const peso = { alto: 3, medio: 2, baixo: 1 };
  out.sort((a, b) => (b.evidencia ? 1 : 0) - (a.evidencia ? 1 : 0) || (peso[b.impacto] || 0) - (peso[a.impacto] || 0));

  return {
    loja, refDate: ctx.refDate,
    sugestoes: out,
    contexto: {
      categorias_sob_ataque: ctx.catsAtaque,
      capital_parado: ctx.capital_parado,
      rupturas: ctx.rupturas.length,
      pares_cesta_fortes: ctx.paresCesta.length,
      produtos_em_fadiga: ctx.fadiga.length,
      subcomunicando: ctx.subcomunicando,
    },
    aviso: "Cada sugestão é uma jogada consagrada em multinacional traduzida para a farmácia. A evidência ao lado vem dos SEUS dados — sem evidência, é só a boa prática genérica.",
  };
}

module.exports = { quadro, criar, atualizar, remover, sugestoes, COLUNAS, JOGADAS };
