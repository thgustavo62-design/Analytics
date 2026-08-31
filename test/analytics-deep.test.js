// Agregados profundos para o Motor. Conferimos contra os totais já conhecidos de agosto.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseVendasPdf } = require("../parsers/vendas");
const { classificar } = require("../classify");
const { analiseProfunda } = require("../analytics-deep");

const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

const lojaCfg = { diasCampanha: [3, 4], campanhaCategoria: "Fraldas" };

test("analiseProfunda: números batem com o mês de agosto (Farma e Farma)", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const p = await parseVendasPdf(FIX);
  const rows = p.rows.map((r) => ({ ...r, categoria: classificar(r.descricao) }));
  const d = analiseProfunda(rows, { lojaCfg });

  assert.equal(d.operacao.faturamento, 196566.57);
  assert.equal(d.operacao.cupons, 4169);
  assert.equal(d.operacao.ticket_medio, 47.15);
  assert.ok(d.operacao.ticket_mediano > 0 && d.operacao.ticket_mediano < d.operacao.ticket_medio, "mediano < médio (cauda de cupons grandes)");
  assert.ok(d.operacao.a_vista_pct > 90 && d.operacao.a_vista_pct <= 100);

  // baseline: 7 dias da semana, cada um com n>=1 e desvio calculado
  assert.equal(d.baseline_semanal.length, 7);
  for (const b of d.baseline_semanal) {
    assert.ok(b.n >= 1);
    assert.ok(Number.isFinite(b.desvio_padrao));
    assert.ok(Number.isFinite(b.faturamento_medio));
  }

  // soma das categorias == faturamento
  const somaCat = d.categorias.reduce((s, c) => s + c.faturamento, 0);
  assert.ok(Math.abs(somaCat - d.operacao.faturamento) < 0.05);

  // campanha calculada (Fraldas, qua/qui) com 2 baselines
  assert.ok(d.campanha && d.campanha.categoria === "Fraldas");
  assert.equal(d.campanha.baselines.length, 2);

  // canais somam ~100% dos cupons
  const somaCupPct = d.canais.reduce((s, c) => s + c.cupons_pct, 0);
  assert.ok(Math.abs(somaCupPct - 100) < 1.5);
});
