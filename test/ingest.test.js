// resolveLoja: descobrir a loja pelo cabeçalho do PDF (CNPJ primeiro, razão social depois).

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveLoja } = require("../ingest");

test("resolveLoja casa pelo CNPJ (com ou sem pontuação)", () => {
  assert.equal(resolveLoja({ cnpj: "31689601000349" }), "Minas Farma");
  assert.equal(resolveLoja({ cnpj: "36.007.525/0001-04" }), "Farma e Farma");
});

test("resolveLoja cai na razão social quando não há CNPJ", () => {
  assert.equal(resolveLoja({ razaoSocial: "Rede Minas Farma" }), "Minas Farma");
  assert.equal(resolveLoja({ razaoSocial: "DROGARIA MELHOR PRECO LTDA" }), "Farma e Farma");
});

test("resolveLoja devolve null quando não reconhece", () => {
  assert.equal(resolveLoja({ cnpj: "00000000000000", razaoSocial: "Farmácia Qualquer" }), null);
  assert.equal(resolveLoja({}), null);
});
