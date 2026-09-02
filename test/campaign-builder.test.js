// Fase B — Campaign Builder 2.0, Motor de Ângulos e combos viáveis.
// Testes puros (objetos sintéticos) + integração opcional com o PDF real de agosto.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-cb-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { ingestVendas } = require("../ingest");
const basket = require("../basket");
const { angulosDeProduto } = require("../marketing/angulos");
const { montarCampanha, parseDias, precoSugerido } = require("../marketing/campaign-builder");

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

function mkProd(over = {}) {
  return Object.assign({
    descricao: "PROD", ean: "7890000000009", categoria: "Limpeza",
    percentis: { receita: 0.6, cupons: 0.6, vmd: 0.6 },
    unidades: { 7: 7, 14: 14, 30: 30, 60: 60, 90: 90 },
    receita: { d30: 400, d90: 1200 }, cupons: { d30: 25, d90: 70 },
    venda_media_diaria: { d7: 1, d30: 1 },
    tendencia: { pct: 0, rotulo: "ESTAVEL" },
    estoque_atual: 60, dias_cobertura: 60, cobertura_infinita: false, cobertura_rotulo: "NORMAL",
    custo_atual: 6, preco_atual: 10, preco_praticado: 10, margem_pct: 0.4,
    do_not_promote: null,
    opportunity: { score: 60, confianca: 0.7, componentes: {}, dados_ausentes: [] },
  }, over);
}

// ---------- Motor de Ângulos ----------
test("angulos: desconto planejado alto => ângulo PRECO", () => {
  const r = angulosDeProduto(mkProd({ papel_primario: "HERO", papeis: ["HERO"] }), { descontoPct: 18, duracaoDias: 3 });
  assert.equal(r.primario, "PRECO");
  assert.ok(r.angulos[0].sugestao_copy.includes("18%"));
});

test("angulos: papel DESOVA puxa URGENCIA", () => {
  const p = mkProd({ papel_primario: "DESOVA", papeis: ["DESOVA"], cobertura_rotulo: "PARADO", dias_cobertura: 300 });
  const r = angulosDeProduto(p, { papelPrimario: "DESOVA", descontoPct: 4, duracaoDias: 7 });
  assert.equal(r.primario, "URGENCIA");
});

test("angulos: concorrência na categoria habilita COMPARACAO como primário", () => {
  const r = angulosDeProduto(mkProd({ papel_primario: "HERO", papeis: ["HERO"], margem_pct: 0.12 }), {
    descontoPct: 3, duracaoDias: 7, concorrenciaCategorias: new Set(["Limpeza"]),
  });
  assert.equal(r.primario, "COMPARACAO"); // peso 0.95 é o maior sem desconto forte nem folga de margem
});

test("angulos: sem custo, ângulo de preço é marcado proxy", () => {
  const r = angulosDeProduto(mkProd({ margem_pct: null, custo_atual: null, papel_primario: "TRAFEGO", papeis: ["TRAFEGO"] }), { descontoPct: 12, duracaoDias: 3 });
  const preco = r.angulos.find((a) => a.id === "PRECO");
  assert.ok(preco && preco.proxy === true);
});

// ---------- preço sugerido ----------
test("precoSugerido: respeita o piso de margem quando há custo", () => {
  const p = mkProd({ preco_atual: 10, custo_atual: 9, margem_pct: 0.1 }); // margem apertada
  const ps = precoSugerido(p, "CHAMARIZ"); // alvo 18%
  assert.ok(ps.preco_sugerido >= 9, `preço promo ${ps.preco_sugerido} ficou abaixo do custo`);
  assert.ok(ps.desconto_pct < 18, "desconto não foi reduzido pelo piso");
});

test("precoSugerido: sem custo, usa o alvo do papel e marca proxy", () => {
  const ps = precoSugerido(mkProd({ custo_atual: null, margem_pct: null }), "DESOVA");
  assert.equal(ps.proxy, true);
  assert.ok(ps.desconto_pct > 0 && ps.desconto_pct <= 35);
});

// ---------- parseDias ----------
test("parseDias aceita números, nomes e string", () => {
  assert.deepEqual(parseDias("5,6,0"), [0, 5, 6]);
  assert.deepEqual(parseDias("sex, sab, dom"), [0, 5, 6]);
  assert.deepEqual(parseDias([2, 1, 1]), [1, 2]);
});

// ---------- combos viáveis ----------
test("basket.combos: viável/qualidade e filtro apenasViaveis (pula se sem cesta)", () => {
  const r = basket.combos("Minas Farma", {});
  if (r.nota) return; // cesta ainda não materializada neste banco temporário
  for (const c of r.combos) {
    assert.ok(typeof c.viavel === "boolean");
    assert.ok(c.qualidade >= 0 && c.qualidade <= 1);
    if (!c.viavel) assert.ok(c.motivo_inviavel, "combo inviável sem motivo");
  }
  const so = basket.combos("Minas Farma", { apenasViaveis: true });
  assert.ok(so.combos.every((c) => c.viavel));
});

// ---------- integração ----------
const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

let LOJA = null;
test("setup: ingere o PDF de agosto", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const r = await ingestVendas(FIX);
  LOJA = r.loja;
  assert.ok(LOJA);
});

test("montarCampanha: janela contígua, elenco por papel, forecast e score", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const d = montarCampanha(LOJA, { dias: "5,6,0", tema: "Teste" });
  assert.ok(!d.erro, d.erro);
  // janela contígua (sex→dom = 2 dias de diferença no máximo)
  if (d.janela.proximo_periodo) {
    const dif = (new Date(d.janela.proximo_periodo.fim) - new Date(d.janela.proximo_periodo.inicio)) / 86400000;
    assert.ok(dif <= 3, `janela não contígua: ${dif} dias`);
  }
  assert.equal(d.janela.duracao_dias, 3);
  // score 0..100
  assert.ok(d.resumo.score_da_campanha >= 0 && d.resumo.score_da_campanha <= 100);
  assert.ok(d.resumo.score_confianca > 0 && d.resumo.score_confianca <= 1);
  // pelo menos um papel preenchido, cada perna com preço/ângulo/forecast
  const legs = Object.values(d.elenco).flat();
  assert.ok(legs.length > 0, "elenco vazio");
  for (const l of legs) {
    assert.ok(l.angulo && l.angulo.primario, "perna sem ângulo");
    assert.ok(l.forecast && l.forecast.cenarios.provavel, "perna sem forecast");
    assert.ok(["conservador", "provavel", "agressivo"].every((k) => k in l.forecast.cenarios));
    if (l.preco_sugerido != null) assert.ok(l.preco_sugerido <= l.preco_ref, "preço sugerido acima do de referência");
  }
  // forecast agregado: 3 cenários monotônicos em unidades
  const f = d.forecast.cenarios;
  assert.ok(f.conservador.unidades <= f.provavel.unidades && f.provavel.unidades <= f.agressivo.unidades, "cenários fora de ordem");
  // nunca promete: tem aviso
  assert.ok(/PROJE|não é promessa/i.test(d.forecast.aviso));
});

test("montarCampanha: sem custo, margem incremental fica null + score sinaliza", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const d = montarCampanha(LOJA, { dias: "1,2" });
  if (d.feeds && d.feeds.custo) return; // essa loja tem custo — nada a checar aqui
  assert.equal(d.forecast.cenarios.provavel.margem_incremental, null);
  assert.ok(d.resumo.score_dados_ausentes.some((x) => /margem/i.test(x)));
});
