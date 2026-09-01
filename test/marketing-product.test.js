// Fase 2 — Marketing Product Intelligence.
// Banco temporário próprio (VA_DB_PATH). Ingere o PDF real de agosto e verifica as
// métricas determinísticas: janelas, tendência, Opportunity Score + componentes, classes,
// do-not-promote e o comportamento com feeds ausentes (nunca inventa número).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-mkt-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const db = require("../db");
const { ingestVendas } = require("../ingest");
const mpa = require("../marketing-product-analytics");

const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

test.after(() => {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

let LOJA = null;
test("setup: ingere o PDF de agosto", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const r = await ingestVendas(FIX);
  LOJA = r.loja;
  assert.ok(LOJA);
  assert.equal(r.meses[0].periodo, "2026-08");
});

test("analisarProdutos: janelas, tendência e população", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const a = mpa.analisarProdutos(LOJA);
  assert.equal(a.refDate, "2026-08-31");
  assert.ok(a.total > 500, `catálogo pequeno: ${a.total}`);
  // pseudo-produtos não entram no marketing
  assert.ok(!a.produtos.some((p) => /^diversos$|taxa de entrega/i.test(p.descricao)), "DIVERSOS/TAXA vazaram");
  // janelas são monotônicas: 90d >= 30d >= 7d em unidades
  for (const p of a.produtos.slice(0, 50)) {
    assert.ok(p.unidades[90] >= p.unidades[30], "u90 < u30");
    assert.ok(p.unidades[30] >= p.unidades[7], "u30 < u7");
    assert.ok(Math.abs(p.tendencia.pct ?? 0) <= 300, "tendência sem clamp");
  }
});

test("Opportunity Score: 0–100, com componentes, contribuições e confiança", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const a = mpa.analisarProdutos(LOJA);
  const p = a.produtos[0];
  const o = p.opportunity;
  assert.ok(o.score >= 0 && o.score <= 100);
  assert.ok(["ALTA", "MEDIA", "BAIXA"].includes(o.rotulo));
  // componentes exigidos
  for (const k of ["demanda", "tendencia", "margem", "estoque", "campanha_historica", "concorrencia", "cesta"]) {
    assert.ok(o.componentes[k], `falta componente ${k}`);
    assert.ok("valor" in o.componentes[k] && "peso" in o.componentes[k] && "contribuicao" in o.componentes[k] && "fonte" in o.componentes[k]);
    assert.ok(o.componentes[k].valor >= 0 && o.componentes[k].valor <= 1);
  }
  // soma das contribuições ≈ score (mesma normalização)
  const soma = Object.values(o.componentes).reduce((s, c) => s + c.contribuicao, 0);
  assert.ok(Math.abs(soma - o.score) <= 1.5, `soma componentes ${soma} vs score ${o.score}`);
  // sem feeds de estoque/custo, a confiança cai e os motivos são listados
  assert.ok(o.confianca < 1, "confiança deveria ser < 1 sem custo/estoque");
  assert.ok(o.dados_ausentes.some((x) => x.startsWith("margem")));
  assert.ok(o.dados_ausentes.some((x) => x.startsWith("estoque")));
});

test("classes de marketing são atribuídas e coerentes", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const a = mpa.analisarProdutos(LOJA);
  const classes = new Set(a.produtos.map((p) => p.classe));
  assert.ok(classes.has("HERO"));
  assert.ok(classes.has("TRAFEGO"));
  // HERO precisa estar no topo de receita
  const heroi = a.produtos.find((p) => p.classe === "HERO");
  assert.ok(heroi.percentis.receita >= 0.8);
});

test("feeds ausentes: margem e dias_cobertura ficam null + flag (nunca inventados)", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const a = mpa.analisarProdutos(LOJA);
  assert.equal(a.feeds.custo, false);
  assert.equal(a.feeds.estoque, false);
  for (const p of a.produtos.slice(0, 100)) {
    assert.equal(p.margem_unitaria, null);
    assert.equal(p.margem_pct, null);
    assert.equal(p.dias_cobertura, null);
    assert.equal(p.cobertura_rotulo, "SEM_ESTOQUE");
  }
  assert.ok(a.dados_ausentes_globais.length >= 2);
});

test("do-not-promote + estoque parado degradam com honestidade sem feed", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const dnp = mpa.naoAnunciar(LOJA);
  // sem custo/estoque e com 1 mês fresco, ninguém é bloqueado por ruptura/margem
  assert.ok(Array.isArray(dnp.produtos));
  for (const p of dnp.produtos) assert.ok(p.do_not_promote.motivos.length);
  const parado = mpa.estoqueParado(LOJA);
  assert.equal(parado.modo, "sem_giro_proxy");
});

test("produtoPorEan devolve um produto com evidências", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const a = mpa.analisarProdutos(LOJA);
  const comEan = a.produtos.find((p) => p.ean);
  const r = mpa.produtoPorEan(LOJA, comEan.ean);
  assert.equal(r.produto.ean, comEan.ean);
  assert.ok(r.produto.opportunity.componentes.demanda.fonte.includes("percentil"));
});
