// Fase A — Marketing Command Center: papel por produto (roles), sub-scores (scores) e o
// plano do dia (command-center). Testes puros (objetos sintéticos) + integração opcional
// com o PDF real de agosto. A camada é determinística: nada é inventado.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-cc-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { ingestVendas } = require("../ingest");
const mpa = require("../marketing-product-analytics");
const { papelDeProduto } = require("../marketing/roles");
const { subScores } = require("../marketing/scores");
const { commandCenter } = require("../marketing/command-center");

const PAPEIS_OK = new Set(["CHAMARIZ", "TRAFEGO", "HERO", "MARGEM", "COMPLEMENTAR", "DESOVA", "RECORRENCIA", "IMAGEM", "GIRO"]);

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

// ---------- objeto de produto sintético (mesma forma que analisarProdutos devolve) ----------
function mkProd(over = {}) {
  const base = {
    descricao: "PRODUTO X", ean: "7890000000001", categoria: "Medicamentos/Outros",
    percentis: { receita: 0.5, cupons: 0.5, vmd: 0.5 },
    unidades: { 7: 7, 14: 14, 30: 30, 60: 60, 90: 90 },
    receita: { d30: 300, d90: 900 }, cupons: { d30: 20, d90: 60 },
    venda_media_diaria: { d7: 1, d30: 1 },
    tendencia: { pct: 0, rotulo: "ESTAVEL" },
    estoque_atual: null, dias_cobertura: null, cobertura_infinita: false, cobertura_rotulo: "SEM_ESTOQUE",
    custo_atual: null, preco_atual: null, preco_praticado: 15, margem_pct: null,
    do_not_promote: null,
    opportunity: {
      score: 55, rotulo: "MEDIA", confianca: 0.6,
      componentes: {
        demanda: { valor: 0.5, peso: 0.22, contribuicao: 11, fonte: "vmd", periodo: "x" },
        tendencia: { valor: 0.5, peso: 0.18, contribuicao: 9, fonte: "t", periodo: "x" },
        margem: { valor: 0.5, peso: 0.15, contribuicao: 7.5, fonte: "sem custo", periodo: "x" },
        estoque: { valor: 0.5, peso: 0.15, contribuicao: 7.5, fonte: "sem feed", periodo: "x" },
        campanha_historica: { valor: 0.5, peso: 0.12, contribuicao: 6, fonte: "fora", periodo: "x" },
        concorrencia: { valor: 0.4, peso: 0.08, contribuicao: 3.2, fonte: "sem", periodo: "x" },
        cesta: { valor: 0.5, peso: 0.1, contribuicao: 5, fonte: "sem", periodo: "x" },
      },
      dados_ausentes: ["margem (sem custo cadastrado)", "estoque (sem feed de estoque)", "cesta (sem par relevante)"],
    },
  };
  return Object.assign(base, over);
}

test("papelDeProduto: alta receita + cobertura ok => HERO", () => {
  const p = mkProd({ percentis: { receita: 0.9, cupons: 0.5, vmd: 0.7 }, cobertura_rotulo: "NORMAL", estoque_atual: 40, dias_cobertura: 40 });
  const r = papelDeProduto(p);
  assert.equal(r.papel_primario, "HERO");
  assert.ok(PAPEIS_OK.has(r.papel_primario));
  assert.ok(r.detalhe[0].rationale.length > 0, "papel sem racional");
  assert.ok(r.confianca > 0 && r.confianca <= 1);
});

test("papelDeProduto: cobertura PARADO => DESOVA entre os papéis", () => {
  const p = mkProd({ cobertura_rotulo: "PARADO", estoque_atual: 500, dias_cobertura: 400 });
  const r = papelDeProduto(p);
  assert.ok(r.papeis.includes("DESOVA"), `papeis=${r.papeis}`);
});

test("papelDeProduto: sem sinal forte => GIRO (fallback)", () => {
  const p = mkProd({ percentis: { receita: 0.2, cupons: 0.2, vmd: 0.2 }, cupons: { d30: 1, d90: 2 } });
  assert.equal(papelDeProduto(p).papel_primario, "GIRO");
});

test("papelDeProduto: do-not-promote por RUPTURA suprime HERO/CHAMARIZ", () => {
  const p = mkProd({
    percentis: { receita: 0.95, cupons: 0.9, vmd: 0.9 }, cobertura_rotulo: "RUPTURA", estoque_atual: 3, dias_cobertura: 1,
    do_not_promote: { motivos: [{ tipo: "RUPTURA", texto: "cobertura baixa", evidencia: { campo: "dias_cobertura", valor: 1, fonte: "x", periodo: "x" } }] },
  });
  const r = papelDeProduto(p);
  assert.ok(!r.papeis.includes("HERO") && !r.papeis.includes("CHAMARIZ"), `papeis=${r.papeis}`);
});

test("subScores: sem custo => profit_score null + flag; creative_score sempre null", () => {
  const s = subScores(mkProd());
  assert.equal(s.profit_score.valor, null);
  assert.ok(/custo/i.test(s.profit_score.ausente));
  assert.equal(s.clearance_score.valor, null); // sem feed de estoque
  assert.equal(s.creative_score.valor, null);
  assert.ok(s.traffic_score.valor >= 0 && s.traffic_score.valor <= 100);
  assert.ok(typeof s.interpretacao === "string" && s.interpretacao.length > 0);
});

test("subScores: com custo e estoque => profit e clearance viram números", () => {
  const p = mkProd({
    margem_pct: 0.35, estoque_atual: 300, cobertura_rotulo: "PARADO", dias_cobertura: 200,
    opportunity: Object.assign(mkProd().opportunity, {
      componentes: Object.assign(mkProd().opportunity.componentes, {
        margem: { valor: 0.8, peso: 0.15, contribuicao: 12, fonte: "margem 35%", periodo: "x" },
        estoque: { valor: 1.0, peso: 0.15, contribuicao: 15, fonte: "parado", periodo: "x" },
      }),
      dados_ausentes: ["cesta (sem par relevante)"],
    }),
  });
  const s = subScores(p);
  assert.ok(s.profit_score.valor > 0, "profit deveria ser numérico");
  assert.ok(s.clearance_score.valor >= 70, `clearance baixo p/ PARADO: ${s.clearance_score.valor}`);
});

test("subScores: do-not-promote derruba o campaign_score", () => {
  const p = mkProd({ do_not_promote: { motivos: [{ tipo: "MARGEM", texto: "x", evidencia: { campo: "margem_pct", valor: -0.1, fonte: "x", periodo: "x" } }] } });
  const s = subScores(p);
  assert.ok(s.campaign_score.valor <= 25);
  assert.ok(/bloqueado/i.test(s.campaign_score.nota));
});

// ---------- integração com o PDF real (pula se a fixture não existir) ----------
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

test("commandCenter: plano do dia com evidência, papel e sub-scores", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const d = commandCenter(LOJA);
  assert.ok(!d.erro, d.erro);
  assert.ok(d.plano_do_dia && Array.isArray(d.plano_do_dia.anunciar));
  assert.ok(d.plano_do_dia.anunciar.length > 0, "nada para anunciar");
  // ranqueado por opportunity desc
  const sc = d.plano_do_dia.anunciar.map((p) => p.opportunity_score);
  for (let i = 1; i < sc.length; i++) assert.ok(sc[i] <= sc[i - 1] + 1e-9, "anunciar fora de ordem");
  for (const p of d.plano_do_dia.anunciar) {
    assert.ok(PAPEIS_OK.has(p.papel_primario), `papel inválido: ${p.papel_primario}`);
    assert.ok(typeof p.acao_sugerida === "string" && p.acao_sugerida.length > 0);
    assert.ok(p.sub_scores && p.sub_scores.creative_score.valor === null, "creative_score deveria ser null na Fase A");
    assert.ok(Array.isArray(p.motivos) && p.motivos.length > 0);
    for (const m of p.motivos) assert.ok(m.evidencia && m.evidencia.campo && "valor" in m.evidencia, "motivo sem evidência");
  }
  // pseudo-produtos nunca entram
  assert.ok(!d.plano_do_dia.anunciar.some((p) => /^diversos$|taxa de entrega/i.test(p.descricao)));
});

test("commandCenter: nao_anunciar traz motivo curto + motivos com evidência", { skip: FIX ? false : "fixture não encontrada" }, () => {
  const d = commandCenter(LOJA);
  for (const p of d.plano_do_dia.nao_anunciar) {
    assert.ok(typeof p.motivo_curto === "string" && p.motivo_curto.length > 0);
    assert.ok(Array.isArray(p.motivos) && p.motivos.length > 0);
    for (const m of p.motivos) assert.ok(m.evidencia && m.evidencia.campo, "motivo sem evidência");
  }
  assert.ok(d.resumo && typeof d.resumo.total_analisado === "number");
});
