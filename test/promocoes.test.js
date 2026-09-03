// Tabela de planejamento de promoções (o "tabelão"/encarte): parser + persistência +
// integração com o Share of Promotions.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-promo-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { parsePromocoes } = require("../parsers/promocoes");
const { ingestVendas, ingestConcorrentes, ingestPromocoes } = require("../ingest");
const db = require("../db");

// fixture csv escrito em UTF-8 de verdade (heredoc do shell erra o encode)
const CSV = path.join(os.tmpdir(), `promo-fix-${process.pid}.csv`);
fs.writeFileSync(CSV, [
  "Produto,EAN,Categoria,Preço De,Preço Por,Desconto,Início,Fim,Campanha,Loja",
  "FRALDA MAMYPOKO JUMBO XG,7896019012345,Fraldas,72.49,56.90,,04/09/2026,06/09/2026,Fim de Semana,geral",
  "SHAMPOO SEDA 325ML,7891150012345,Higiene,14.90,,25%,04/09/2026,06/09/2026,Fim de Semana,Minas Farma",
  "DIPIRONA 500MG C/10,,Medicamentos/Outros,8.90,6.49,,,,Sempre,Farma e Farma",
  "PRODUTO SEM OFERTA,,Outros,10.00,,,,,,geral",
].join("\n"), "utf8");

test.after(() => {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
  try { fs.unlinkSync(CSV); } catch {}
});

test("parsePromocoes: colunas, datas DD/MM, desconto derivado, loja", () => {
  const r = parsePromocoes(CSV);
  assert.ok(r.header.colunas.includes("preco_normal") && r.header.colunas.includes("preco_promo"));
  assert.equal(r.resumo.total, 3); // "PRODUTO SEM OFERTA" cai fora
  const fralda = r.linhas.find((l) => /MAMYPOKO/.test(l.descricao));
  assert.equal(fralda.data_inicio, "2026-09-04", "DD/MM lido como MM/DD");
  assert.equal(fralda.data_fim, "2026-09-06");
  assert.equal(fralda.loja, "__todas__");
  assert.ok(Math.abs(fralda.desconto_pct - (1 - 56.9 / 72.49)) < 0.01, "desconto não derivado do de/por");
  const seda = r.linhas.find((l) => /SEDA/.test(l.descricao));
  assert.ok(Math.abs(seda.preco_promo - 14.9 * 0.75) < 0.02, "preço promo não derivado do desconto");
  assert.equal(seda.loja, "Minas Farma");
  const dip = r.linhas.find((l) => /DIPIRONA/.test(l.descricao));
  assert.equal(dip.data_inicio, null);
  assert.equal(dip.data_fim, null);
  assert.equal(dip.loja, "Farma e Farma");
});

test("substituir + vigência por data + re-upload substitui", () => {
  db.lojaId("Minas Farma"); // garante que o schema/lojas existem
  const { linhas } = parsePromocoes(CSV);
  const r1 = db.substituirPromocoesPlanejadas("fix.csv", linhas);
  assert.equal(r1.linhas, 3);

  // DIPIRONA (sem datas) vale sempre; FRALDA/SEDA só 04–06/09
  assert.equal(db.promocoesVigentes("Farma e Farma", "2026-08-15").length, 1, "só a sem-prazo vale em agosto");
  assert.ok(db.promocoesVigentes("Minas Farma", "2026-09-05").length >= 2, "as com prazo valem em 05/09");
  assert.equal(db.promocoesVigentes("Farma e Farma", "2026-10-01").filter((p) => /MAMYPOKO/.test(p.descricao)).length, 0, "expirada não aparece");

  // re-upload do mesmo arquivo não duplica
  const r2 = db.substituirPromocoesPlanejadas("fix.csv", linhas);
  assert.equal(r2.linhas, 3);
  const total = db.db.prepare("SELECT COUNT(*) n FROM promocoes_planejadas").get().n;
  assert.ok(total <= 5, `re-upload duplicou linhas: ${total}`);

  const porCat = db.promocoesPorCategoria("Minas Farma", "2026-09-05");
  assert.ok([...porCat.keys()].some((c) => /Fraldas|Higiene/.test(c)));
  for (const [, e] of porCat) assert.ok(Array.isArray(e.exemplos));
});

const PDF = [
  process.env.VENDAS_FIXTURE,
  "C:\\Sistema Marketing\\inbox\\vendas agosto farma e farma.pdf",
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].find((p) => p && fs.existsSync(p));
const XLSX_CONC = ["C:\\Sistema Marketing\\inbox\\Concorrentes_Coleta_2026-08-31.xlsx"].find((p) => fs.existsSync(p));

test("integração: Share of Promotions usa a tabela de planejamento", { skip: PDF && XLSX_CONC ? false : "fixtures (vendas + coleta) não encontradas" }, async () => {
  const rv = await ingestVendas(PDF);
  ingestConcorrentes(XLSX_CONC);
  ingestPromocoes(CSV);
  const conc = require("../concorrencia-analise").analisarConcorrencia(rv.loja);
  assert.ok(conc.share_promocoes, "sem share_promocoes");
  assert.match(conc.share_promocoes.fonte_nossas, /tabela de planejamento/i);
  // DIPIRONA (Medicamentos/Outros -> canônico "Medicamento", sem prazo) deve contar como ação nossa
  const med = conc.share_promocoes.por_categoria.find((c) => /^Medicamento/.test(c.categoria));
  assert.ok(med && med.nossas_promocoes >= 1 && med.nossas_exemplos.length >= 1, JSON.stringify(med));
});
