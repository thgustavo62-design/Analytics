// Fase E — Concorrência ofensiva: Share of Promotions + contra-ataque com produto alternativo.
// Integração: ingere o PDF de agosto + a coleta de concorrentes e checa a análise.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP_DB = path.join(os.tmpdir(), `analytics-conc-${process.pid}.db`);
process.env.VA_DB_PATH = TMP_DB;
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} }

const { ingestVendas, ingestConcorrentes } = require("../ingest");
const { analisarConcorrencia } = require("../concorrencia-analise");
const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "lojas.json"), "utf8"));

test.after(() => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP_DB + s); } catch {} } });

const PDF = [
  process.env.VENDAS_FIXTURE,
  path.join(__dirname, "fixtures", "vendas-agosto-farma-e-farma.pdf"),
  "C:\\Sistema Marketing\\inbox\\vendas\\vendas agosto farma e farma.pdf",
  "C:\\Users\\Admin\\Downloads\\vendas agosto farma e farma.pdf",
].filter(Boolean).find((p) => fs.existsSync(p));
const XLSX = [
  process.env.CONC_FIXTURE,
  "C:\\Sistema Marketing\\inbox\\concorrentes\\Concorrentes_Coleta_2026-08-31.xlsx",
].filter(Boolean).find((p) => fs.existsSync(p));

const SKIP = PDF && XLSX ? false : "fixtures (PDF de vendas + xlsx de coleta) não encontradas";

let LOJA = null;
test("setup: ingere vendas + coleta de concorrentes", { skip: SKIP }, async () => {
  const r = await ingestVendas(PDF);
  LOJA = r.loja;
  const c = ingestConcorrentes(XLSX);
  assert.ok(c.aplicadas.some((a) => a.loja === LOJA && a.ofertas > 0), "coleta não aplicada à loja das vendas");
});

const VEREDITOS_OK = new Set([
  "sem atividade promocional na categoria",
  "subcomunicando — concorrência abaixo do nosso preço e sem ação nossa",
  "concorrência abaixo do nosso preço, mas categoria de pouca receita nossa",
  "concorrência comunicando forte (mas não abaixo do nosso preço) — avaliar presença",
  "esforço promocional sem pressão que justifique — reavaliar prioridade",
  "equilibrado",
]);

test("share_promocoes: estrutura e vereditos coerentes", { skip: SKIP }, () => {
  const a = analisarConcorrencia(LOJA);
  assert.ok(!a.pendente, "coleta não reconhecida");
  const sp = a.share_promocoes;
  assert.ok(sp && Array.isArray(sp.por_categoria) && sp.por_categoria.length > 0);
  assert.ok(Array.isArray(sp.resumo) && sp.resumo.length > 0);
  // sem campanhas cadastradas no banco temporário → nossas_promocoes_total = 0
  assert.equal(sp.nossas_promocoes_total, 0);
  // por_concorrente inclui a linha "nós"
  assert.ok(sp.por_concorrente.some((c) => c.nos === true));
  // ao menos uma categoria do calendário aparece como recorrente
  const catsCal = new Set((LOJAS_CFG[LOJA].campanhas || []).flatMap((c) => c.categorias || []));
  const temRecor = sp.por_categoria.some((c) => c.promo_recorrente && catsCal.has(c.categoria));
  assert.ok(temRecor, "nenhuma categoria do calendário marcada como recorrente");
  for (const c of sp.por_categoria) {
    assert.ok(VEREDITOS_OK.has(c.veredito), `veredito inesperado: ${c.veredito}`);
    assert.ok(c.ofertas_abaixo_do_nosso <= c.ofertas_concorrentes, "abaixo do nosso > total de ofertas");
    // "subcomunicando" só quando há oferta do concorrente abaixo do nosso preço e sem ação nossa
    if (/^subcomunicando/.test(c.veredito)) {
      assert.ok(c.ofertas_abaixo_do_nosso >= 2, "subcomunicando sem pressão real");
      assert.ok(c.nossas_promocoes === 0 && !c.promo_recorrente, "subcomunicando com ação nossa");
    }
    if (/reavaliar prioridade/.test(c.veredito)) {
      assert.ok(c.nossas_promocoes > 0 || c.promo_recorrente, "esforço-sem-pressão sem ação nossa");
      assert.equal(c.ofertas_concorrentes, 0);
    }
  }
});

test("contra-ataque: alternativa da mesma categoria, nunca o próprio produto", { skip: SKIP }, () => {
  const a = analisarConcorrencia(LOJA);
  const comContra = a.onde_reagir.filter((r) => r.contra_ataque);
  for (const r of comContra) {
    // só aparece quando não vale cobrir o SKU original
    assert.match(r.veredito, /não cobrir|aperta a margem|quase não vende/i);
    const c = r.contra_ataque;
    assert.ok(c.produto && c.motivo, "contra-ataque sem produto/motivo");
    assert.notEqual(c.produto.toLowerCase().trim(), r.produto.toLowerCase().trim(), "contra-ataque aponta para o próprio produto");
    assert.equal(c.categoria == null || c.categoria === r.categoria, true);
  }
  // ação textual coerente se houver contra-ataques
  if (comContra.length) assert.ok(a.acoes.some((x) => /promover no lugar/i.test(x)));
});
