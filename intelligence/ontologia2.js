// Fase 7 — Ontologia 2.0: persiste o grafo (nós/arestas com força, confiança e
// temporalidade) e o enriquece com PRODUTO / MARCA / SUBCATEGORIA a partir da Fase 2.
// Mantém `ontologia.js` (tela "Conexões") intacto — aqui é a camada persistida.

const db = require("../db");
const { construirOntologia } = require("../ontologia");
const mpa = require("../marketing-product-analytics");

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const marcaDe = (descricao) => {
  const t = String(descricao || "").trim().split(/\s+/).slice(0, 2).join(" ");
  return t.replace(/[^A-Za-zÀ-ÿ0-9 ]/g, "").trim() || null;
};

function sincronizarOntologia(loja, periodo, { vendasRows, concRows, lojaCfg, analiseComercial } = {}) {
  // 1) grafo base (o mesmo da tela Conexões)
  const base = construirOntologia({ loja, periodo, vendasRows, concRows, lojaCfg: lojaCfg || {}, analiseComercial });
  const hoje = new Date().toISOString().slice(0, 10);

  for (const n of base.nodes) {
    db.upsertOntologyNode(loja, { chave: n.id, tipo: n.tipo, rotulo: n.rotulo, atributos: { sub: n.sub || null, metricas: n.metricas || null } });
  }
  for (const e of base.edges) {
    db.upsertOntologyEdge(loja, { de: e.de, para: e.para, tipo: e.tipo, forca: e.peso != null ? Math.min(1, e.peso) : 0.5, confianca: 0.6, valid_from: hoje, atributos: { rotulo: e.rotulo || null } });
  }

  // 2) enriquecimento: PRODUTO / MARCA / SUBCATEGORIA a partir do marketing-product-analytics
  let enriquecidos = 0;
  try {
    const a = mpa.analisarProdutos(loja);
    const top = (a.produtos || []).slice(0, 60); // top por opportunity
    const marcas = new Set();
    for (const p of top) {
      const pchave = "prod:" + (p.ean || norm(p.descricao));
      db.upsertOntologyNode(loja, {
        chave: pchave, tipo: "produto", rotulo: p.descricao,
        atributos: { ean: p.ean, classe: p.classe, opportunity: p.opportunity.score, categoria: p.categoria, tendencia: p.tendencia.rotulo },
      });
      // produto -> categoria
      db.upsertOntologyEdge(loja, { de: pchave, para: "cat:" + norm(p.categoria), tipo: "pertence", forca: 0.9, confianca: 0.9, valid_from: hoje });
      // fallback: liga também à chave que a ontologia base usa (varia); tenta "cat:<Categoria>"
      db.upsertOntologyEdge(loja, { de: pchave, para: "categoria:" + p.categoria, tipo: "pertence", forca: 0.6, confianca: 0.5, valid_from: hoje });
      const marca = marcaDe(p.descricao);
      if (marca) {
        const mchave = "marca:" + norm(marca);
        if (!marcas.has(mchave)) {
          db.upsertOntologyNode(loja, { chave: mchave, tipo: "marca", rotulo: marca, atributos: {} });
          marcas.add(mchave);
        }
        db.upsertOntologyEdge(loja, { de: pchave, para: mchave, tipo: "da_marca", forca: 0.7, confianca: 0.5, valid_from: hoje });
      }
      enriquecidos++;
    }
    // 3) arestas de cesta: produto <-> produto "combina"
    const cesta = db.getCestaPares(loja, { limite: 120 });
    for (const par of cesta.pares) {
      db.upsertOntologyEdge(loja, {
        de: "prod:" + (par.ean_a || norm(par.desc_a)),
        para: "prod:" + (par.ean_b || norm(par.desc_b)),
        tipo: "combina", forca: Math.min(1, (par.lift - 1) / 5), confianca: Math.min(1, par.confidence + 0.2), valid_from: hoje,
        atributos: { lift: par.lift, support: par.support },
      });
    }
  } catch (e) {
    /* enriquecimento é best-effort */
  }

  // 4) sinais abertos viram nós ligados à entidade
  for (const s of db.listSinais(loja, { status: "aberto", limite: 40 })) {
    const schave = "sinal:" + s.codigo;
    db.upsertOntologyNode(loja, { chave: schave, tipo: "sinal", rotulo: s.titulo, atributos: { classe: s.classe, tipo: s.tipo, prioridade: s.prioridade } });
    if (s.entidade_tipo && s.entidade_ref) {
      const alvo = s.entidade_tipo === "produto" ? "prod:" + s.entidade_ref
        : s.entidade_tipo === "categoria" ? "cat:" + norm(s.entidade_ref)
        : s.entidade_tipo === "campanha" ? "campanha:" + norm(s.entidade_ref)
        : s.entidade_tipo === "concorrente" ? "concorrente:" + norm(s.entidade_ref)
        : "loja";
      db.upsertOntologyEdge(loja, { de: schave, para: alvo, tipo: "sobre", forca: s.prioridade / 100, confianca: s.confianca, valid_from: hoje });
    }
  }

  const persistida = db.getOntologiaPersistida(loja);
  return { loja, periodo, base: { nodes: base.nodes.length, edges: base.edges.length }, enriquecidos, persistida: { nodes: persistida.nodes.length, edges: persistida.edges.length } };
}

module.exports = { sincronizarOntologia };
