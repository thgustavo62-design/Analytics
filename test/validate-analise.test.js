// Validador do JSON do Motor de Análise Comercial (Fase 2).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { validate } = require("../validate-analise");

const EXEMPLO = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", "analise-comercial.example.json"), "utf8"));

test("o exemplo do schema passa", () => {
  const r = validate(EXEMPLO);
  assert.equal(r.ok, true, r.erros.join("; "));
});

test("recusa loja fora da lista", () => {
  const d = structuredClone(EXEMPLO);
  d.meta.loja = "Farmácia X";
  const r = validate(d);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => /meta\.loja/.test(e)));
});

test("recusa decisão de campanha inválida", () => {
  const d = structuredClone(EXEMPLO);
  d.campanhas[0].decisao = "TALVEZ";
  const r = validate(d);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => /decisao inválida/.test(e)));
});

test("recusa pergunta_central sem booleano", () => {
  const d = structuredClone(EXEMPLO);
  d.pergunta_central = { motivo: "..." };
  const r = validate(d);
  assert.equal(r.ok, false);
  assert.ok(r.erros.some((e) => /melhor_caminho/.test(e)));
});

test("aceita campos numéricos como null (contrato)", () => {
  const d = structuredClone(EXEMPLO);
  d.kpis[0].valor = null;
  d.diagnostico_executivo.decisao_principal.impacto_estimado_mes = null;
  assert.equal(validate(d).ok, true);
});

test("raiz não-objeto é recusada", () => {
  assert.equal(validate("nope").ok, false);
  assert.equal(validate([]).ok, false);
});
