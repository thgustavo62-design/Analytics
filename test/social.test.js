// Redes sociais — leitura de número pt-BR, tráfego pago no banco, análise e o gancho na Medição.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-social-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { numBR } = require("../parsers/social-vision");
const db = require("../db");
const { analiseSocial } = require("../social-analise");
const { ingestVendas } = require("../ingest");

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

test("numBR: números em pt-BR (mil/mi, ponto de milhar, vírgula decimal, R$, %)", () => {
  assert.equal(numBR("1,2 mil"), 1200);
  assert.equal(numBR("414,3 mil"), 414300);
  assert.equal(numBR("12,3 mi"), 12300000);
  assert.equal(numBR("1.234"), 1234);
  assert.equal(numBR("1.234.567"), 1234567);
  assert.equal(numBR("R$ 1.234,56"), 1234.56);
  assert.equal(numBR("3,4%"), 3.4);
  assert.equal(numBR("+64,7"), 64.7);
  assert.equal(numBR("−12"), null); // sinal unicode "−" não é dígito -> parseFloat falha; ok tratar como ausente
  assert.equal(numBR("-12"), -12);
  assert.equal(numBR("—"), null);
  assert.equal(numBR(""), null);
  assert.equal(numBR(2500), 2500);
});

const PDF = [
  process.env.VENDAS_FIXTURE,
  "C:\\Sistema Marketing\\inbox\\vendas agosto farma e farma.pdf",
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].find((p) => p && fs.existsSync(p));
const SKIP = PDF ? false : "fixture de vendas não encontrada";

let LOJA = null, ANO = null, MES = null;
test("setup: período real a partir do PDF", { skip: SKIP }, async () => {
  const r = await ingestVendas(PDF);
  LOJA = r.loja;
  const p = db.listPeriodos(LOJA).find((x) => x.temVendas);
  [ANO, MES] = p.periodo.split("-").map(Number);
});

test("mergeInstagram: mescla mantendo o que já existe e sobrepondo o preenchido", { skip: SKIP }, () => {
  const pid = db.findPeriodo(LOJA, ANO, MES).id;
  db.mergeInstagram(pid, [
    { metrica: "alcance", rotulo: "Alcance", valor_exibicao: "10 mil", delta_pct: 5 },
    { metrica: "interacoes", rotulo: "Interações", valor_exibicao: "800", delta_pct: null },
  ]);
  db.mergeInstagram(pid, [
    { metrica: "alcance", rotulo: "Alcance", valor_exibicao: "12 mil", delta_pct: 20 }, // sobrepõe
    { metrica: "seguidores", rotulo: "Seguidores", valor_exibicao: "45", delta_pct: null }, // adiciona
  ]);
  const rows = db.getInstagram(pid);
  const m = Object.fromEntries(rows.map((r) => [r.metrica, r]));
  assert.equal(m.alcance.valor_exibicao, "12 mil");
  assert.equal(m.alcance.delta_pct, 20);
  assert.equal(m.interacoes.valor_exibicao, "800"); // preservado
  assert.equal(m.seguidores.valor_exibicao, "45");
});

test("trafego pago: insere, soma por mês e alimenta a Medição (Fase C)", { skip: SKIP }, () => {
  const pid = db.findPeriodo(LOJA, ANO, MES).id;
  db.inserirTrafegoPago(pid, { fonte_arquivo: "p1.png", investimento: 300, impressoes: 20000, cliques: 400, resultados: 25, tipo_resultado: "mensagens", custo_por_resultado: 12, plataforma: "Instagram" });
  db.inserirTrafegoPago(pid, { fonte_arquivo: "p2.png", investimento: 150, impressoes: 8000, cliques: 120, resultados: 8, tipo_resultado: "mensagens" });
  const soma = db.investimentoTrafegoPago(LOJA, ANO, MES);
  assert.equal(soma.total, 450);
  assert.equal(soma.n, 2);

  const { medirCampanha } = require("../marketing/campaign-measure");
  const med = medirCampanha(LOJA, { dias: [3, 4], categorias: ["Fraldas"], refDate: `${ANO}-${String(MES).padStart(2, "0")}-15` });
  // sem passar investimento, deve puxar dos prints de tráfego pago
  assert.equal(med.investimento, 450);
  assert.match(med.investimento_fonte || "", /tráfego pago/);
});

test("analiseSocial: estrutura, séries, tráfego pago e cruzamento", { skip: SKIP }, () => {
  const d = analiseSocial(LOJA);
  assert.ok(!d.erro, d.erro);
  assert.equal(d.tem_dados, true);
  assert.equal(d.organico.series.length, 6);
  const alc = d.organico.series.find((s) => s.metrica === "alcance");
  assert.ok(alc.pontos.length >= 1 && alc.pontos[alc.pontos.length - 1].valor === 12000);
  assert.ok(Array.isArray(d.organico.leitura) && d.organico.leitura.length >= 1);
  assert.equal(d.pago.serie.length, 1);
  assert.equal(d.pago.serie[0].investimento, 450);
  assert.equal(d.pago.serie[0].cpc, Math.round((450 / 520) * 100) / 100);
  assert.ok(d.cruzamento.tabela_mensal.some((r) => r.investimento_pago === 450 && r.faturamento != null));
  assert.equal(d.motor_visao_ativo, false); // sem chave neste ambiente
});

test("analiseSocial: loja inválida", () => {
  assert.ok(analiseSocial("Loja X").erro);
});
