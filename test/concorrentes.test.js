// Casamento oferta-de-concorrente x produto nosso. O filtro por Marca (coluna da planilha)
// tem que barrar casamento errado tipo "Loção Nivea" -> "FLETOP LOCAO".

const test = require("node:test");
const assert = require("node:assert/strict");
const { bestMatch } = require("../match");
const { parseValidade, parsePreco } = require("../parsers/concorrentes");

test("bestMatch: marca como filtro duro barra falso-positivo", () => {
  const nossos = [
    { name: "FLETOP LOCAO 200ML" },
    { name: "HIDRAT NIVEA 400ML SOFT MILK" },
    { name: "DES. REXONA AEROSOL 150ML COTTON" },
  ];
  // sem marca: "Loção ... 200ml" casa com FLETOP (errado)
  const semMarca = bestMatch("Loção Deo-Hidratante Nivea Milk 200ml", nossos, { minScore: 0.3 });
  // com a marca certa, só casa se o candidato contiver "NIVEA"
  const comMarca = bestMatch("Loção Deo-Hidratante Nivea Milk 400ml", nossos, { minScore: 0.3, brand: "Nivea" });
  assert.ok(comMarca && /NIVEA/.test(comMarca.match.name), "casou com o produto da marca Nivea");
  assert.ok(!comMarca || !/FLETOP/.test(comMarca.match.name), "não casou com FLETOP");

  const erra = bestMatch("Creme Dental Colgate Tripla Ação 90g", [{ name: "COREGA ULTRA CREME 20G TRIPLA ACAO" }], { minScore: 0.3, brand: "Colgate" });
  assert.equal(erra, null, "Colgate não casa com COREGA");
});

test("parseValidade entende 'até DD/MM/AAAA', ISO e Date", () => {
  assert.equal(parseValidade("até 10/09/2026"), "2026-09-10");
  assert.equal(parseValidade("2026-09-10"), "2026-09-10");
  assert.equal(parseValidade(new Date("2026-09-10T12:00:00Z")), "2026-09-10");
  assert.equal(parseValidade(""), null);
});

test("parsePreco entende número, vírgula e R$", () => {
  assert.equal(parsePreco(8.99), 8.99);
  assert.equal(parsePreco("8,99"), 8.99);
  assert.equal(parsePreco("R$ 1.299,90"), 1299.9);
  assert.equal(parsePreco(null), null);
});
