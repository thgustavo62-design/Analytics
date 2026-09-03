// Curva ABC por receita: classificação, resumo e o filtro A+B nas listas de marketing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-abc-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { classificarProdutosABC, curvaABC } = require("../marketing/abc");
const mpa = require("../marketing-product-analytics");
const { ingestVendas } = require("../ingest");

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

test("classificarProdutosABC: corte cumulativo A/B/C + receita 0 -> C", () => {
  // receitas: 800, 100, 50, 30, 15, 5  (total 1000)
  const prods = [
    { ean: "1", receita: { d90: 800 } },
    { ean: "2", receita: { d90: 100 } },
    { ean: "3", receita: { d90: 50 } },
    { ean: "4", receita: { d90: 30 } },
    { ean: "5", receita: { d90: 15 } },
    { ean: "6", receita: { d90: 5 } },
    { ean: "7", receita: { d90: 0 } },
  ];
  const resumo = classificarProdutosABC(prods);
  const abc = Object.fromEntries(prods.map((p) => [p.ean, p.abc]));
  // classe = classe do % ACUMULADO ANTES do item (corte "< 0.80" p/ A, "< 0.95" p/ B)
  // 1: antes=0.00 -> A ; 2: antes=0.80 -> B ; 3: antes=0.90 -> B ; 4: antes=0.95 -> C ; 7: receita 0 -> C
  assert.equal(abc["1"], "A");
  assert.equal(abc["2"], "B");
  assert.equal(abc["3"], "B");
  assert.equal(abc["4"], "C");
  assert.equal(abc["7"], "C");
  assert.ok(Math.abs(resumo.A.pct_receita + resumo.B.pct_receita + resumo.C.pct_receita - 100) < 0.5);
  assert.equal(resumo.A.n + resumo.B.n + resumo.C.n, 7);
});

const PDF = [
  process.env.VENDAS_FIXTURE,
  "C:\\Sistema Marketing\\inbox\\vendas agosto farma e farma.pdf",
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].find((p) => p && fs.existsSync(p));
const SKIP = PDF ? false : "fixture de vendas não encontrada";

let LOJA = null;
test("setup: ingere o PDF de agosto", { skip: SKIP }, async () => {
  const r = await ingestVendas(PDF);
  LOJA = r.loja;
});

test("curvaABC: produtos + categorias + clientes", { skip: SKIP }, () => {
  const d = curvaABC(LOJA);
  assert.ok(!d.erro, d.erro);
  for (const k of ["A", "B", "C"]) assert.ok(d.produtos[k] && typeof d.produtos[k].n === "number");
  assert.ok(d.produtos.A.n > 0);
  assert.ok(Math.abs(d.produtos.A.pct_receita + d.produtos.B.pct_receita + d.produtos.C.pct_receita - 100) < 1);
  assert.ok(d.produtos.A.pct_receita >= d.produtos.C.pct_receita, "A deveria concentrar mais receita que C");
  // categorias ordenadas desc por receita e cada uma com classe
  assert.ok(Array.isArray(d.categorias) && d.categorias.length > 0);
  for (let i = 1; i < d.categorias.length; i++) assert.ok(d.categorias[i].receita_90d <= d.categorias[i - 1].receita_90d + 1e-6);
  for (const c of d.categorias) assert.ok(["A", "B", "C"].includes(c.abc));
  assert.ok(d.clientes && typeof d.clientes.disponivel === "boolean");
});

test("analisarProdutos marca .abc e recomendados esconde a classe C", { skip: SKIP }, () => {
  const a = mpa.analisarProdutos(LOJA);
  assert.ok(a.produtos.every((p) => ["A", "B", "C"].includes(p.abc)), "produto sem .abc");
  assert.ok(a.abc && a.abc.A.n > 0);

  const rec = mpa.recomendados(LOJA);
  assert.ok(rec.produtos.every((p) => p.abc !== "C"), "recomendados trouxe classe C");
  assert.ok(rec.ocultos_classe_c >= 0);

  const recC = mpa.recomendados(LOJA, { incluirC: true });
  assert.ok(recC.produtos.length >= rec.produtos.length);
});
