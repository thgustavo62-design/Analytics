// Fase 1 — catálogo por EAN + histórico de estoque/custo/preço.
// Usa um banco temporário próprio (VA_DB_PATH) — não toca no data/analytics.db real.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-test-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const db = require("../db");
const { sincronizarProdutosDeVendas, normalizarEan, ingestPlanilhaProduto, detectarTipoPlanilha } = require("../catalogo");
const { classificar } = require("../classify");
const { parseVendasPdf } = require("../parsers/vendas");

const ESTOQUE_FIX = [
  process.env.ESTOQUE_FIXTURE,
  path.join(__dirname, "fixtures", "estoque-minas-farma.xlsx"),
  "C:\\Users\\Admin\\Downloads\\estoque minas farma.xlsx",
].filter(Boolean).find((p) => fs.existsSync(p));

const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

test.after(() => {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

test("normalizarEan aceita 8–14 dígitos e rejeita lixo", () => {
  assert.equal(normalizarEan("7891000315507"), "7891000315507");
  assert.equal(normalizarEan(" 7891000315507 "), "7891000315507");
  assert.equal(normalizarEan("0000000000000"), null);
  assert.equal(normalizarEan("123"), null);
  assert.equal(normalizarEan(""), null);
  assert.equal(normalizarEan("DIVERSOS"), null);
});

test("sincronizarProdutosDeVendas popula o catálogo a partir das vendas", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const parsed = await parseVendasPdf(FIX);
  const rows = parsed.rows.map((r) => ({ ...r, categoria: classificar(r.descricao) }));
  const periodoId = db.getOrCreatePeriodo("Farma e Farma", 2026, 8);
  db.replaceVendas(periodoId, rows);

  const r = sincronizarProdutosDeVendas(periodoId);
  assert.ok(r.criados > 100, "criou centenas de produtos");

  const c = db.contagemCatalogo();
  assert.ok(c.produtos > 100);
  assert.ok(c.comEan > c.produtos * 0.8, "a maioria tem EAN");

  // um produto conhecido veio com EAN e categoria
  const leite = db.db.prepare("SELECT * FROM produtos WHERE descricao_normalizada LIKE '%ninho%' LIMIT 1").get();
  assert.ok(leite, "achou um produto de leite");
  assert.ok(leite.ean, "tem EAN");
  assert.ok(leite.categoria, "tem categoria classificada");

  // idempotente: rodar de novo não duplica
  const r2 = sincronizarProdutosDeVendas(periodoId);
  assert.equal(r2.criados, 0);
  assert.equal(db.contagemCatalogo().produtos, c.produtos);
});

test("planilha de estoque da rede alimenta estoque + custo + preço + promoção do MESMO arquivo", { skip: ESTOQUE_FIX ? false : "fixture de estoque não encontrada" }, () => {
  assert.equal(detectarTipoPlanilha(path.basename(ESTOQUE_FIX).toLowerCase()), "estoque");
  const r = ingestPlanilhaProduto(ESTOQUE_FIX);
  assert.ok(r.feeds_do_arquivo, "não reportou os sub-feeds");
  assert.ok(r.feeds_do_arquivo.estoque > 500, "poucas linhas de estoque");
  assert.ok(r.feeds_do_arquivo.custo > 100, "não leu 'Últ. Prc. Entrada' como custo");
  assert.ok(r.feeds_do_arquivo.preco > 100 && r.feeds_do_arquivo.preco_promocional > 100);
  assert.ok(r.sem_produto < r.linhas_aplicadas * 0.05, "muitos produtos não casaram");

  const fr = db.freshnessCatalogo("Minas Farma");
  assert.ok(fr.estoque.ultima && fr.custo.ultima && fr.preco.ultima, "freshness não registrou os 3 feeds");

  // um produto qualquer com EAN tem estoque, custo e preço coerentes (custo <= preço)
  const lid = db.lojaId("Minas Farma");
  const hoje = new Date().toISOString().slice(0, 10);
  const p = db.db.prepare("SELECT id FROM produtos WHERE ean IS NOT NULL AND fonte IN ('catalogo','vendas') LIMIT 1").get();
  const cst = db.getCustoEm(lid, p.id, hoje);
  const prc = db.getPrecoEm(lid, p.id, hoje, "normal");
  if (cst && prc) assert.ok(cst.custo > 0 && prc.preco >= cst.custo, "custo maior que preço — mapeamento de coluna trocado");
});

test("custo é historizado (fecha a vigência anterior; consulta por data)", () => {
  const lid = db.lojaId("Minas Farma");
  const up = db.upsertProduto({ ean: "7899999999999", descricao: "PRODUTO TESTE 500ML", descricao_normalizada: "produto teste 500ml", categoria: "Medicamentos/Outros", fonte: "catalogo" });
  const pid = up.id;

  db.inserirCusto(lid, pid, 10.0, "2026-06-01", "teste");
  db.inserirCusto(lid, pid, 12.5, "2026-08-01", "teste");

  const emJulho = db.getCustoEm(lid, pid, "2026-07-15");
  assert.equal(emJulho.custo, 10.0);
  assert.equal(emJulho.data_fim, "2026-07-31");

  const emAgosto = db.getCustoEm(lid, pid, "2026-08-10");
  assert.equal(emAgosto.custo, 12.5);
  assert.equal(emAgosto.data_fim, null);
});

test("preço normal e promocional convivem; correção manual prevalece", () => {
  const lid = db.lojaId("Minas Farma");
  const p = db.getProdutoPorEan("7899999999999");
  db.inserirPreco(lid, p.id, 19.9, "2026-08-01", "normal", "teste");
  db.inserirPreco(lid, p.id, 14.9, "2026-08-01", "promocional", "teste");
  assert.equal(db.getPrecoEm(lid, p.id, "2026-08-05", "normal").preco, 19.9);
  assert.equal(db.getPrecoEm(lid, p.id, "2026-08-05", "promocional").preco, 14.9);

  const ef1 = db.produtoEfetivo(db.getProdutoPorId(p.id));
  db.setProdutoOverride(p.id, { categoria_manual: "Limpeza" });
  const ef2 = db.produtoEfetivo(db.getProdutoPorId(p.id));
  assert.notEqual(ef1.categoria, "Limpeza");
  assert.equal(ef2.categoria, "Limpeza");
  assert.equal(ef2.fonte, "manual");
});
