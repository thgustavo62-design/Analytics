// Data Quality — score, problemas com severidade/impacto/como-corrigir, freshness.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-dq-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const db = require("../db");
const { ingestVendas } = require("../ingest");
const { dataQuality } = require("../marketing/data-quality");

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

const SEV = new Set(["ALTO", "MEDIO", "BAIXO"]);

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

test("dataQuality: score, problemas e freshness bem formados", { skip: SKIP }, () => {
  const d = dataQuality(LOJA);
  assert.ok(!d.erro, d.erro);
  assert.ok(d.score >= 0 && d.score <= 100);
  assert.ok(typeof d.veredito === "string" && d.veredito.length > 0);
  assert.ok(d.por_severidade && ["ALTO", "MEDIO", "BAIXO"].every((k) => typeof d.por_severidade[k] === "number"));
  assert.equal(d.por_severidade.ALTO + d.por_severidade.MEDIO + d.por_severidade.BAIXO, d.problemas.length);
  for (const p of d.problemas) {
    assert.ok(SEV.has(p.severidade), `severidade inesperada: ${p.severidade}`);
    assert.ok(p.titulo && typeof p.n === "number" && p.como_corrigir, JSON.stringify(p));
  }
  // problemas ordenados por severidade (ALTO antes de BAIXO)
  const ordem = { ALTO: 0, MEDIO: 1, BAIXO: 2 };
  for (let i = 1; i < d.problemas.length; i++) assert.ok(ordem[d.problemas[i].severidade] >= ordem[d.problemas[i - 1].severidade]);
  // freshness dos feeds
  for (const k of ["vendas", "estoque", "custo", "preco"]) assert.ok(k in d.freshness);
  assert.equal(d.freshness.vendas.ultima, d.refDate);
});

test("custo proxy entre lojas: usa o custo da outra loja quando a própria não tem", { skip: SKIP }, () => {
  const mpa = require("../marketing-product-analytics");
  const outra = LOJA === "Farma e Farma" ? "Minas Farma" : "Farma e Farma";
  const lidLoja = db.lojaId(LOJA);
  const lidOutra = db.lojaId(outra);
  // 1º call ANTES de mexer no custo — pega um produto vendido sem custo em lugar nenhum
  const semCusto = mpa.analisarProdutos(LOJA).produtos.find((p) => p.produto_id && p.custo_atual == null && (p.receita.d30 || 0) > 0);
  if (!semCusto) return;
  db.inserirCusto(lidOutra, semCusto.produto_id, 3.21, "2026-08-01", "teste-proxy");
  // muda a memoKey passando um Set de concorrência (altera o 'c' da chave do memo)
  const b = mpa.analisarProdutos(LOJA, { concorrenciaCategorias: new Set(["__x__"]) });
  const alvo = b.produtos.find((p) => p.produto_id === semCusto.produto_id);
  assert.ok(alvo, "produto sumiu");
  assert.equal(alvo.custo_atual, 3.21);
  assert.equal(alvo.custo_proxy, true);
  assert.equal(alvo.custo_proxy_origem, outra);
  assert.ok(b.custo_proxy && b.custo_proxy.n >= 1);
});

test("dataQuality: detecta custo > preço", { skip: SKIP }, () => {
  // insere um produto com custo cadastrado acima do preço de venda
  const lid = db.lojaId(LOJA);
  const r = db.upsertProduto({ ean: "7890000validX", descricao: "PRODUTO CUSTO ERRADO", descricao_normalizada: "produto custo errado", categoria: "Medicamento", fonte: "catalogo" });
  db.inserirPreco(lid, r.id, 10, "2026-08-01", "normal", "teste");
  db.inserirCusto(lid, r.id, 25, "2026-08-01", "teste");
  const d = dataQuality(LOJA);
  const prob = d.problemas.find((p) => p.id === "custo_maior_que_preco");
  assert.ok(prob, "não detectou custo > preço");
  assert.ok(prob.n >= 1);
});
