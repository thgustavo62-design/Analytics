// Fase 4 — Market Basket. Verifica support/confidence/lift, os limites de ruído e a
// materialização em cesta_pares. Banco temporário próprio.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-basket-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const db = require("../db");
const { ingestVendas } = require("../ingest");
const basket = require("../basket");

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
});

test("calcularCesta: métricas dentro da faixa e limites respeitados", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r = basket.calcularCesta(LOJA);
  assert.ok(!r.erro, r.erro);
  assert.ok(r.total_cupons > 1000);
  for (const p of r.pares) {
    assert.ok(p.support >= r.parametros.min_support);
    assert.ok(p.lift >= r.parametros.min_lift);
    assert.ok(Math.max(p.confidence, p.confidence_ba) >= r.parametros.min_confidence);
    assert.ok(p.cupons_ab >= r.parametros.min_cupons_par);
    assert.ok(Math.min(p.cupons_a, p.cupons_b) >= r.parametros.min_cupons_isolado);
    // definição: confidence(A->B) = cupons_ab / cupons_a (valor arredondado a 4 casas)
    assert.ok(Math.abs(p.confidence - p.cupons_ab / p.cupons_a) < 1e-3);
    // não são pseudo-produtos
    assert.ok(!/^diversos$|taxa de entrega/i.test(p.desc_a));
    assert.ok(!/^diversos$|taxa de entrega/i.test(p.desc_b));
  }
});

test("materializa em cesta_pares e getCestaPares devolve a última janela", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const r = basket.calcularCesta(LOJA);
  const got = db.getCestaPares(LOJA);
  assert.equal(got.pares.length, r.pares.length);
  if (got.janela) {
    assert.equal(got.janela.fim, "2026-08-31");
  }
});

test("centralidade devolve mapa produto->[0,1]", { skip: FIX ? false : "fixture não encontrada" }, () => {
  basket.calcularCesta(LOJA);
  const c = basket.centralidade(LOJA);
  assert.ok(c instanceof Map);
  for (const v of c.values()) assert.ok(v >= 0 && v <= 1);
});

test("combos anexam o retrato de marketing de cada perna", { skip: FIX ? false : "fixture não encontrada" }, () => {
  basket.calcularCesta(LOJA);
  const r = basket.combos(LOJA);
  assert.ok(Array.isArray(r.combos));
  for (const co of r.combos) {
    assert.ok(co.produto_a && co.produto_b);
    assert.ok(co.papel && co.papel.ancora && co.papel.isca);
    assert.ok(co.evidencia.campo === "lift");
  }
});

test("amostra insuficiente é reportada, não inventada", () => {
  // loja sem vendas -> erro explícito
  const r = basket.calcularCesta("Minas Farma");
  assert.ok(r.erro);
  assert.deepEqual(r.pares, []);
});
