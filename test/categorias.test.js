// Vocabulário canônico de categoria + mapeamento do grupo do ERP + super-grupos.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { categoriaCanonica, mapGrupoErp, expandirSuperGrupo } = require("../categorias");

test("categoriaCanonica: aliases dos rótulos antigos e da coleta", () => {
  assert.equal(categoriaCanonica("Perfumaria/Higiene"), "Higiene e Beleza");
  assert.equal(categoriaCanonica("Medicamentos/Outros"), "Medicamento");
  assert.equal(categoriaCanonica("Higiene Bucal"), "Higiene e Beleza");
  assert.equal(categoriaCanonica("Desodorante"), "Higiene e Beleza");
  assert.equal(categoriaCanonica("Bebê"), "Bebê");
  assert.equal(categoriaCanonica("bebe"), "Bebê");
  assert.equal(categoriaCanonica("Dermocosmético"), "Dermocosmético");
  assert.equal(categoriaCanonica("GENERICOS - GENERICO"), "Medicamento");
  assert.equal(categoriaCanonica(null), null);
  assert.equal(categoriaCanonica(""), null);
  // rótulo desconhecido passa em title-case
  assert.equal(categoriaCanonica("categoria nova xpto"), "Categoria Nova Xpto");
});

test("mapGrupoErp: prefixo do grupo distingue OTC de Ético", () => {
  assert.deepEqual(mapGrupoErp("OTC - ETICOS OTC"), { categoria: "Medicamento", subcategoria: null, classe_comercial: "OTC" });
  assert.deepEqual(mapGrupoErp("OTC - ETICOS/LIBERADOS OTC"), { categoria: "Medicamento", subcategoria: null, classe_comercial: "OTC" });
  assert.equal(mapGrupoErp("ETICO - ETICOS 20% DESC.").classe_comercial, "Ético");
  assert.equal(mapGrupoErp("GENERICOS - GENERICO ONEROSO").classe_comercial, "Genérico");
  assert.equal(mapGrupoErp("SIMILARES - SIMILAR").classe_comercial, "Similar");
});

test("mapGrupoErp: subgrupo vira subcategoria", () => {
  assert.deepEqual(mapGrupoErp("PERFUMARIA - PERFUMARIA HIG. PESSOAL"), { categoria: "Higiene e Beleza", subcategoria: "Higiene Pessoal", classe_comercial: null });
  assert.deepEqual(mapGrupoErp("PERFUMARIA - PERFUMARIA GERAL"), { categoria: "Higiene e Beleza", subcategoria: "Perfumaria", classe_comercial: null });
  assert.deepEqual(mapGrupoErp("PERFUMARIA - PERFUMARIA PERICULTURA"), { categoria: "Bebê", subcategoria: "Puericultura", classe_comercial: null });
  assert.equal(mapGrupoErp("FRALDAS - FRALDAS").categoria, "Fraldas");
  assert.equal(mapGrupoErp("LEITES - LEITE/FORMULA").categoria, "Leite Infantil");
  assert.equal(mapGrupoErp("DESODORANTES").subcategoria, "Desodorante");
  assert.equal(mapGrupoErp("CORRELATOS - HOSPITALARES/ORTOPEDICOS").categoria, "Saúde e Bem-estar");
  assert.equal(mapGrupoErp("GRUPO INEXISTENTE ZZZ"), null);
  assert.equal(mapGrupoErp(null), null);
});

test("expandirSuperGrupo: Bebê cobre Fraldas e Leite Infantil", () => {
  const b = expandirSuperGrupo("Bebê");
  assert.ok(b.includes("Bebê") && b.includes("Fraldas") && b.includes("Leite Infantil"));
  assert.deepEqual(expandirSuperGrupo("Limpeza"), ["Limpeza"]);
  // rótulo cru do concorrente também expande
  assert.ok(expandirSuperGrupo("bebe").includes("Fraldas"));
});

// integração leve: upsertProduto respeita o rank da fonte da categoria
test("upsertProduto: categoria do ERP não é sobrescrita pela de vendas", () => {
  const TMP = path.join(os.tmpdir(), `analytics-cat-${process.pid}.db`);
  process.env.VA_DB_PATH = TMP;
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP + s); } catch {} }
  const db = require("../db");
  const r = db.upsertProduto({ ean: "7890000009999", descricao: "PRODUTO TESTE X", descricao_normalizada: "produto teste x", categoria: "Medicamento", categoria_fonte: "vendas", fonte: "vendas" });
  db.setProdutoErp(r.id, { categoria: "Higiene e Beleza", subcategoria: "Perfumaria" });
  let p = db.getProdutoPorId(r.id);
  assert.equal(p.categoria, "Higiene e Beleza");
  assert.equal(p.categoria_fonte, "erp");
  // uma nova sincronização de vendas (categoria_fonte 'vendas') NÃO volta pra "Medicamento"
  db.upsertProduto({ ean: "7890000009999", descricao: "PRODUTO TESTE X", descricao_normalizada: "produto teste x", categoria: "Medicamento", categoria_fonte: "vendas", fonte: "vendas" });
  p = db.getProdutoPorId(r.id);
  assert.equal(p.categoria, "Higiene e Beleza", "vendas sobrescreveu a categoria do ERP");
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP + s); } catch {} }
});
