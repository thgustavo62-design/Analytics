// resolveLoja: descobrir a loja pelo cabeçalho do PDF (CNPJ primeiro, razão social depois).
// + roteamento por PASTA da inbox.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const INBOX = fs.mkdtempSync(path.join(os.tmpdir(), "va-inbox-"));
process.env.VA_INBOX = INBOX;
process.env.VA_DB_PATH = path.join(INBOX, "t.db");

const { resolveLoja, ingestFile, criarPastasInbox, PASTAS_NOMES } = require("../ingest");

test.after(() => { try { fs.rmSync(INBOX, { recursive: true, force: true }); } catch {} });

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

test("inbox: cria as subpastas por tipo", () => {
  criarPastasInbox(INBOX);
  for (const p of PASTAS_NOMES) {
    assert.ok(fs.existsSync(path.join(INBOX, p)), `faltou inbox/${p}`);
    assert.ok(fs.existsSync(path.join(INBOX, p, "LEIA-ME.txt")));
  }
});

test("roteamento por pasta: o tipo vem da PASTA, não do nome do arquivo", async () => {
  // planilha de redes sociais com nome que NÃO bate em nenhuma palavra-chave
  const p = path.join(INBOX, "redes-sociais", "xpto 123.csv");
  fs.writeFileSync(p, "Loja,Mes,Alcance,Interacoes,Seguidores\nMinas Farma,2026-08,\"50 mil\",\"2.000\",\"100\"\n");
  const r = await ingestFile(p);
  assert.equal(r.tipo, "social-planilha");
  assert.ok(r.aplicadas.some((a) => a.loja === "Minas Farma"));
});

test("roteamento por pasta: aninhado em subpasta ainda acha o tipo", async () => {
  const dir = path.join(INBOX, "redes-sociais", "2026", "agosto");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "coisa.csv");
  fs.writeFileSync(p, "Loja,Mes,Alcance,Seguidores\nFarma e Farma,2026-08,\"31 mil\",\"90\"\n");
  const r = await ingestFile(p);
  assert.equal(r.tipo, "social-planilha");
});

test("roteamento por pasta: extensão errada na pasta é recusada com mensagem clara", async () => {
  const p = path.join(INBOX, "vendas", "nao-e-pdf.xlsx");
  fs.writeFileSync(p, "x");
  await assert.rejects(() => ingestFile(p), /pasta "inbox\/vendas\/" só lê \.pdf/);
});

test("roteamento por pasta: arquivo na RAIZ da inbox continua pelo dispatch por nome", async () => {
  const p = path.join(INBOX, "arquivo_solto.csv");
  fs.writeFileSync(p, "x,y\n1,2\n");
  // csv na raiz sem palavra-chave -> erro do dispatch antigo (não o da pasta)
  await assert.rejects(() => ingestFile(p), /csv só é lido como/);
});
