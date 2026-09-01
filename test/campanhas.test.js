// Fase 3 — Campanhas: eficiência do calendário, Campaign Builder, Offer Simulator e o
// CRUD/import do calendário. Banco temporário próprio.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-camp-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const db = require("../db");
const { ingestVendas } = require("../ingest");
const camp = require("../campanhas");

const FIX = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));

test.after(() => {
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }
});

let LOJA = null;
test("setup: ingere o PDF de agosto", { skip: FIX ? false : "fixture não encontrada" }, async () => {
  const r = await ingestVendas(FIX);
  LOJA = r.loja; // "Farma e Farma"
});

test("eficiênciaCalendario: DEMAND_LIFT e veredito a partir de números reais", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const e = camp.eficienciaCalendario(LOJA, { nome: "Limpeza (sexta a domingo)" });
  assert.ok(!e.erro, e.erro);
  assert.ok(e.metricas.DEMAND_LIFT_receita > 0);
  assert.ok(["EXCELENTE", "BOA", "ACEITAVEL", "FRACA", "DESTRUTIVA", "INCONCLUSIVO"].includes(e.veredito));
  // sem feeds: métricas dependentes são null e listadas, não inventadas
  assert.equal(e.metricas.MARGIN_SACRIFICE, null);
  assert.equal(e.metricas.SELL_THROUGH, null);
  assert.ok(e.dados_ausentes.some((x) => /MARGIN_SACRIFICE/.test(x)));
  assert.equal(e.evidencia.campo, "DEMAND_LIFT_receita");
  // sem custo, nunca afirma "DESTRUTIVA"
  assert.notEqual(e.veredito, "DESTRUTIVA");
});

test("campaignBuilder: elenco por papel + lista de evitar + briefing textual", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const b = camp.campaignBuilder(LOJA, { objetivo: "GIRAR_ESTOQUE", categorias: ["Limpeza"] });
  assert.ok(!b.erro, b.erro);
  for (const papel of camp.PAPEIS) assert.ok(Array.isArray(b.elenco[papel]), `sem papel ${papel}`);
  assert.ok(b.elenco.CHAMARIZ.length > 0, "CHAMARIZ vazio");
  assert.ok(b.elenco.HERO.length > 0, "HERO vazio");
  // sem custo, MARGEM entra como proxy declarado
  if (b.elenco.MARGEM.length) assert.ok(b.elenco.MARGEM.every((x) => x.proxy === true));
  // só categoria pedida
  for (const papel of camp.PAPEIS) for (const it of b.elenco[papel]) assert.equal(it.categoria, "Limpeza");
  assert.ok(b.briefing.includes("BRIEFING DE CAMPANHA"));
  assert.ok(b.briefing.includes("sem estimativa da IA"));
});

test("offerSimulator: cenários rotulados, nunca promessa; margem null sem custo", { skip: FIX ? false : "fixture não encontrada" }, () => {
  // pega um EAN real da loja
  const alvo = db.vendasPorProdutoJanela(LOJA, "2026-08-01", "2026-08-31").filter((r) => r.barras && r.unidades > 20)[0];
  const s = camp.offerSimulator(LOJA, { ean: alvo.barras, preco_atual: 10, preco_promocional: 8, duracao_dias: 3 });
  assert.ok(!s.erro, s.erro);
  assert.equal(s.desconto_pct, 20);
  assert.equal(s.margem.atual, null); // sem custo
  assert.equal(s.cenarios.length, 3);
  assert.deepEqual(s.cenarios.map((c) => c.cenario), ["CONSERVADOR", "PROVAVEL", "AGRESSIVO"]);
  // agressivo projeta >= provável >= conservador
  assert.ok(s.cenarios[2].unidades_projetadas >= s.cenarios[1].unidades_projetadas);
  assert.ok(s.cenarios[1].unidades_projetadas >= s.cenarios[0].unidades_projetadas);
  assert.ok(/PROJE[ÇC]/i.test(s.aviso) && /N[ÃA]O .*promessa/i.test(s.aviso));
});

test("offerSimulator exige preços quando não há tabela cadastrada", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const alvo = db.vendasPorProdutoJanela(LOJA, "2026-08-01", "2026-08-31").filter((r) => r.barras)[0];
  const s = camp.offerSimulator(LOJA, { ean: alvo.barras });
  assert.ok(s.erro);
  assert.ok(s.faltando.includes("preco_atual"));
});

test("importarCalendarioCampanhas é idempotente", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));
  const cfg = LOJAS_CFG[LOJA].campanhas;
  const n1 = db.importarCalendarioCampanhas(LOJA, cfg);
  const n2 = db.importarCalendarioCampanhas(LOJA, cfg);
  assert.equal(n1, cfg.length);
  assert.equal(n2, 0);
  const lista = db.listCampanhas(LOJA);
  assert.ok(lista.length >= cfg.length);
});

test("CRUD de campanha persiste produtos e resultado", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const id = db.criarCampanha(LOJA, { nome: "Teste Fralda Set", objetivo: "GIRAR_ESTOQUE", categoria: "Fraldas", data_inicio: "2026-09-05", data_fim: "2026-09-07" });
  const prod = db.vendasPorProdutoJanela(LOJA, "2026-08-01", "2026-08-31").filter((r) => r.barras)[0];
  const pRow = db.getProdutoPorEan(require("../catalogo").normalizarEan(prod.barras));
  db.addCampanhaProduto(id, { produto_id: pRow.id, papel: "CHAMARIZ", preco_promocional: 9.9, prioridade: 1 });
  db.setCampanhaResultado(id, { resultado: "BOA", score: 72, metricas: { DEMAND_LIFT: 1.3 } });
  const c = db.getCampanha(id);
  assert.equal(c.produtos.length, 1);
  assert.equal(c.produtos[0].papel, "CHAMARIZ");
  assert.equal(c.resultado.resultado, "BOA");
  assert.equal(c.resultado.metricas.DEMAND_LIFT, 1.3);
  db.removerCampanha(id);
  assert.equal(db.getCampanha(id), null);
});
