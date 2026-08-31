// Regressão do parser de vendas.
//
// Fixture: o relatório real de agosto/2026 da Farma e Farma (235 páginas). O parser tem
// que fechar EXATAMENTE no "Total:" impresso (R$ 196.566,57) — foi assim que a análise
// manual foi validada.
//
// Por padrão lê de C:\Users\Admin\Downloads. Sobrescreva com VENDAS_FIXTURE=<caminho> ou
// copie o PDF para test/fixtures/vendas-agosto-farma-e-farma.pdf.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseVendasPdf } = require("../parsers/vendas");

const CANDIDATES = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean);

const FIXTURE = CANDIDATES.find((p) => fs.existsSync(p));

test("parser fecha exatamente no Total impresso (agosto Farma e Farma)", { skip: FIXTURE ? false : "fixture não encontrada" }, async () => {
  const r = await parseVendasPdf(FIXTURE);

  assert.equal(r.printedTotal, 196566.57, "Total impresso lido do rodapé");
  assert.equal(r.total, 196566.57, "soma calculada bate com o Total impresso");
  assert.equal(r.rows.length, 9353, "número de linhas de item");

  const lancamentos = new Set(r.rows.map((x) => x.lancamento)).size;
  assert.equal(lancamentos, 4169, "lançamentos (vendas) únicos");

  assert.equal(r.periodo.inicio, "2026-08-01");
  assert.equal(r.periodo.fim, "2026-08-31");
  assert.equal(r.lastDay, "2026-08-31");
  assert.equal(r.lastDayPartial, true, "31/08 é dia parcial (relatório gerado 07:40)");

  // toda linha tem os campos essenciais
  for (const row of r.rows) {
    assert.ok(row.data && /^\d{4}-\d{2}-\d{2}$/.test(row.data));
    assert.ok(Number.isFinite(row.valor_liquido));
    assert.ok(row.forma_pagto === "A VISTA" || row.forma_pagto === "A PRAZO");
  }
});

const MINAS = [
  process.env.VENDAS_FIXTURE_MINAS,
  path.join(__dirname, "fixtures", "vendas-agosto-minas-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto minas farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

test(
  "parser fecha no Total impresso com linhas de ARREDONDAMENTO negativas (agosto Minas Farma)",
  { skip: MINAS ? false : "fixture Minas não encontrada" },
  async () => {
    const r = await parseVendasPdf(MINAS);
    assert.equal(r.total, 478723.02);
    assert.equal(r.printedTotal, 478723.02);
    // as 5 linhas de ajuste de arredondamento têm valor negativo
    const negativos = r.rows.filter((x) => x.valor_liquido < 0);
    assert.ok(negativos.length >= 1, "linhas negativas de ARREDONDAMENTO reconhecidas");
  }
);

test("parser aborta quando a soma não bate", async () => {
  await assert.rejects(() => parseVendasPdf(path.join(__dirname, "fixtures", "nao-existe.pdf")));
});
