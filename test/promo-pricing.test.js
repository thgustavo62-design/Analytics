// Promo Pricing Engine — elasticidade, curva lucro×desconto, preço recomendado, ranking de oportunidades.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-pp-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const pp = require("../marketing/promo-pricing");
const mpa = require("../marketing-product-analytics");
const db = require("../db");
const { ingestVendas } = require("../ingest");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "elasticidade.json"), "utf8"));
// o setup insere custos DEPOIS de um analisarProdutos sem opts; passar um Set não-vazio muda a
// chave do memo de mpa (usa .size) e força o recálculo já com os custos cadastrados.
const FRESH = new Set(["__pp_test__"]);

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

test("elasticidadeDe: categoria configurada, default e canonicalização", () => {
  const med = pp.elasticidadeDe("Medicamento");
  assert.equal(med.valor, CFG.por_categoria.Medicamento);
  assert.equal(med.categoria, "Medicamento");

  const desconhecida = pp.elasticidadeDe("Categoria Que Não Existe");
  assert.equal(desconhecida.valor, CFG.default);
  assert.match(desconhecida.fonte, /default/);

  // rótulo em caixa livre deve canonicalizar e achar a mesma elasticidade
  const frald = pp.elasticidadeDe("fraldas");
  assert.equal(frald.categoria, "Fraldas");
  assert.equal(frald.valor, CFG.por_categoria.Fraldas);
});

const PDF = [
  process.env.VENDAS_FIXTURE,
  "C:\\Sistema Marketing\\inbox\\vendas\\vendas agosto farma e farma.pdf",
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].find((p) => p && fs.existsSync(p));
const SKIP = PDF ? false : "fixture de vendas não encontrada";

let LOJA = null;
test("setup: ingere o PDF de agosto e cadastra custos sintéticos (~55% do preço)", { skip: SKIP }, async () => {
  const r = await ingestVendas(PDF);
  LOJA = r.loja;
  // o PDF não traz custo; para exercitar o caminho baseado em lucro, cadastro custo em 55% do preço
  const lid = db.lojaId(LOJA);
  const prods = mpa.analisarProdutos(LOJA).produtos
    .filter((p) => p.produto_id && (p.preco_atual != null || p.preco_praticado != null) && (p.venda_media_diaria && p.venda_media_diaria.d30) > 0);
  for (const p of prods) {
    const preco = p.preco_atual != null ? p.preco_atual : p.preco_praticado;
    db.inserirCusto(lid, p.produto_id, Math.round(preco * 0.55 * 100) / 100, "2026-07-01", "teste-pp");
  }
});

test("oportunidadesPromo: ranking por lucro incremental, sem classe C, com aviso de premissa", { skip: SKIP }, () => {
  const o = pp.oportunidadesPromo(LOJA, { n: 12, concorrenciaCategorias: FRESH });
  assert.ok(!o.erro, o.erro);
  assert.ok(Array.isArray(o.produtos));
  assert.ok(o.horizonte_dias >= 1);
  assert.match(o.aviso, /elasticidade/i);

  // ordenado desc por lucro incremental previsto
  for (let i = 1; i < o.produtos.length; i++) {
    assert.ok(o.produtos[i].lucro_incremental_previsto <= o.produtos[i - 1].lucro_incremental_previsto + 1e-6);
  }
  for (const p of o.produtos) {
    assert.notEqual(p.abc, "C");                       // só A/B entram
    assert.ok(p.desconto_pct > 0, "oferta sem desconto não deveria entrar");
    assert.ok(p.lucro_incremental_previsto > 0, "com custo, só entra se dá lucro incremental");
    assert.ok(p.preco_recomendado < p.preco_normal);
  }
  // soma do top bate com o campo agregado
  const soma = o.produtos.reduce((s, x) => s + x.lucro_incremental_previsto, 0);
  assert.ok(Math.abs(soma - o.potencial_lucro_incremental_top) < 0.05);

  // bucket sem custo: nunca traz lucro projetado
  if (o.sem_custo && o.sem_custo.produtos.length) {
    for (const p of o.sem_custo.produtos) assert.equal(p.lucro_incremental_previsto, null);
  }
});

test("precificarProduto: curva, recomendado maximiza lucro incremental e respeita o piso de margem", { skip: SKIP }, () => {
  const o = pp.oportunidadesPromo(LOJA, { n: 20, concorrenciaCategorias: FRESH });
  const comCusto = o.produtos.find((p) => p.margem_pct_na_promo != null);
  assert.ok(comCusto, "esperava ao menos um produto com custo (próprio ou proxy) no top");

  const d = pp.precificarProduto(LOJA, { descricao: comCusto.produto, duracaoDias: 3, concorrenciaCategorias: FRESH });
  assert.ok(!d.erro, d.erro);
  assert.ok(Array.isArray(d.curva) && d.curva.length >= 2);
  assert.ok(d.testar.length >= 1 && d.testar.length <= 3);
  assert.equal(d.testar.filter((t) => t.rotulo === "recomendado").length, 1);
  assert.match(d.aviso, /premissa/i);

  // recomendado é o ponto de maior lucro incremental da curva
  const maxLucro = Math.max(...d.curva.map((c) => c.lucro_incremental));
  assert.ok(Math.abs(d.recomendado.lucro_incremental - maxLucro) < 1e-6);

  // preço = preço normal * (1 - desconto)
  assert.ok(Math.abs(d.recomendado.preco - d.preco_normal * (1 - d.recomendado.desconto_pct / 100)) < 0.02);

  // nunca abaixo do piso de margem configurado
  for (const c of d.curva) {
    if (c.margem_pct != null) assert.ok(c.margem_pct >= CFG.piso_margem_pct - 1e-6, `margem ${c.margem_pct} < piso`);
  }

  // limites coerentes
  assert.ok(d.limites.desconto_teto_pct <= CFG.desconto_teto * 100 + 1e-6);
  if (d.limites.break_even_desconto_pct != null) assert.ok(d.limites.break_even_desconto_pct > 0);

  // o efeito-cesta é exibido mas não decide: existe o campo e não altera o ranqueamento
  assert.ok("efeito_cesta_estimado" in d.recomendado);
});

test("precificarProduto: monotonia da demanda com o desconto (elasticidade negativa)", { skip: SKIP }, () => {
  const o = pp.oportunidadesPromo(LOJA, { n: 5, concorrenciaCategorias: FRESH });
  if (!o.produtos.length) return;
  const d = pp.precificarProduto(LOJA, { descricao: o.produtos[0].produto, duracaoDias: 3, concorrenciaCategorias: FRESH });
  for (let i = 1; i < d.curva.length; i++) {
    assert.ok(d.curva[i].multiplicador_demanda >= d.curva[i - 1].multiplicador_demanda - 1e-9, "mais desconto deveria não reduzir a demanda projetada");
    assert.ok(d.curva[i].preco <= d.curva[i - 1].preco + 1e-9);
  }
});

test("precificarProduto: produto inexistente devolve erro", { skip: SKIP }, () => {
  const d = pp.precificarProduto(LOJA, { descricao: "zzz produto que nao existe zzz", concorrenciaCategorias: FRESH });
  assert.ok(d.erro);
});

test("oportunidadesPromo: recorte por_grupo cobre os grupos e embute o detalhe de cada produto", { skip: SKIP }, () => {
  const o = pp.oportunidadesPromo(LOJA, { n: 8, concorrenciaCategorias: FRESH });
  assert.ok(Array.isArray(o.por_grupo) && o.por_grupo.length >= 1, "sem por_grupo");
  assert.deepEqual(o.grupos_disponiveis, o.por_grupo.map((g) => g.categoria));
  // por_grupo ordenado desc por lucro incremental total
  for (let i = 1; i < o.por_grupo.length; i++) assert.ok(o.por_grupo[i].lucro_incremental_total <= o.por_grupo[i - 1].lucro_incremental_total + 1e-6);
  // a soma dos produtos de todos os grupos = total de linhas interessantes (nada perdido/duplicado)
  const totalNoGrupo = o.por_grupo.reduce((s, g) => s + g.n_interessantes, 0);
  const totalListado = o.produtos.length + o.sem_custo.n; // top é subconjunto, mas com custo todos entram em por_grupo
  assert.ok(totalNoGrupo >= o.produtos.length, "por_grupo não cobre o ranking");
  for (const g of o.por_grupo) {
    assert.ok(g.produtos.length === g.mostrando && g.mostrando <= g.n_interessantes);
    for (const p of g.produtos) {
      assert.ok(p.produto_id != null || p.ean != null, "produto do grupo sem identificador");
      assert.ok(p.detalhe && !p.detalhe.erro, "grupo sem detalhe embutido");
      assert.ok(p.detalhe.recomendado && p.detalhe.testar.length >= 1, "detalhe incompleto");
      assert.equal(p.detalhe.curva, undefined, "detalhe do grupo deveria ser sem curva");
      // o preço/desc do resumo bate com o recomendado do detalhe
      assert.equal(p.preco_recomendado, p.detalhe.recomendado.preco);
      assert.equal(p.desconto_pct, p.detalhe.recomendado.desconto_pct);
    }
  }
  // o ranking global embute a curva (reamostrada) para o gráfico
  for (const p of o.produtos) {
    assert.ok(p.detalhe && Array.isArray(p.detalhe.curva) && p.detalhe.curva.length >= 2, "ranking sem curva embutida");
    assert.ok(p.detalhe.aviso === undefined, "detalhe não deveria repetir o aviso");
  }
});

test("precoRapido: só devolve produtos que valem promoção, com preço/margem coerentes", { skip: SKIP }, () => {
  const o = pp.oportunidadesPromo(LOJA, { n: 10, concorrenciaCategorias: FRESH });
  const ids = o.produtos.map((p) => p.produto_id).filter(Boolean);
  if (!ids.length) return;
  const m = pp.precoRapido(LOJA, { concorrenciaCategorias: FRESH }, ids);
  assert.ok(m instanceof Map);
  for (const [, rec] of m) {
    assert.ok(rec.desconto_pct > 0);
    assert.ok(rec.preco_recomendado < rec.preco_normal);
    if (rec.margem_pct_na_promo != null) assert.ok(rec.margem_pct_na_promo >= CFG.piso_margem_pct - 1e-6);
    assert.equal(rec.elasticidade_premissa, true);
  }
});
