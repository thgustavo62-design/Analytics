// Vermelhinha Analytics — backend.
// Sobe os documentos brutos (relatório de vendas PDF, métricas do Instagram, planilha de
// concorrentes), o backend processa e serve o painel já validado, com histórico por
// loja/mês. Nunca lê nem escreve nada dentro de app_minasfarma/.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

const {
  LOJAS_VALIDAS,
  getOrCreatePeriodo,
  findPeriodo,
  getPeriodoById,
  listPeriodos,
  replaceVendas,
  setVendasMeta,
  getVendas,
  replaceInstagram,
  getInstagram,
  replaceConcorrencia,
  getConcorrencia,
} = require("./db");
const { parseVendasPdf } = require("./parsers/vendas");
const { normalizeInstagram } = require("./parsers/instagram");
const { parseConcorrentes } = require("./parsers/concorrentes");
const { classificar } = require("./classify");
const { aggregate } = require("./aggregate");
const { gerarInsights } = require("./insights");

const PORT = process.env.PORT || 4180;
const UPLOAD_DIR = path.join(__dirname, "data", "uploads");
const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- auth (senha única, ferramenta interna) ---------------------------------

let APP_PASSWORD = process.env.APP_PASSWORD;
if (!APP_PASSWORD) {
  APP_PASSWORD = crypto.randomBytes(4).toString("hex");
  console.warn(`\n  ⚠  APP_PASSWORD não definida no ambiente.`);
  console.warn(`     Usando senha temporária desta sessão: ${APP_PASSWORD}\n`);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}
function makeToken() {
  const body = `ok.${Date.now()}`;
  return `${body}.${sign(body)}`;
}
function validToken(tok) {
  if (!tok) return false;
  const parts = tok.split(".");
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  return sign(body) === parts[2];
}
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

const LOGIN_PAGE = (erro) => `<!doctype html><meta charset="utf-8"><title>Entrar — Vermelhinha Analytics</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f4f1ec;color:#2b2b2b;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:min(340px,90vw)}
h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#8a8378;font-size:13px}
input{width:100%;padding:10px 12px;border:1px solid #d9d2c7;border-radius:8px;font-size:15px;box-sizing:border-box}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#c62828;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#c62828;font-size:13px;margin-top:10px}</style>
<form method="post" action="/login">
<h1>Vermelhinha Analytics</h1><p class="sub">Ferramenta interna — Nova7</p>
<input type="password" name="senha" placeholder="Senha" autofocus autocomplete="current-password">
<button type="submit">Entrar</button>
${erro ? '<div class="err">Senha incorreta.</div>' : ""}
</form>`;

app.get("/login", (req, res) => res.type("html").send(LOGIN_PAGE(req.query.erro)));
app.post("/login", (req, res) => {
  if ((req.body.senha || "") === APP_PASSWORD) {
    res.setHeader("Set-Cookie", `va_session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return res.redirect("/");
  }
  res.redirect("/login?erro=1");
});
app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "va_session=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/login");
});

// tudo abaixo exige sessão (VA_NO_AUTH=1 desliga — só para teste local, nunca em produção)
const NO_AUTH = process.env.VA_NO_AUTH === "1";
if (NO_AUTH) console.warn("  ⚠  VA_NO_AUTH=1 — autenticação DESLIGADA (use só localmente).");
app.use((req, res, next) => {
  if (NO_AUTH) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (validToken(cookies.va_session)) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/upload/")) {
    return res.status(401).json({ erro: "não autenticado" });
  }
  res.redirect("/login");
});

// --- uploads ---------------------------------------------------------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function periodoSlug(ano, mes) {
  return `${ano}-${String(mes).padStart(2, "0")}`;
}
function validarLojaPeriodo(body) {
  const loja = String(body.loja || "").trim();
  const ano = parseInt(body.ano, 10);
  const mes = parseInt(body.mes, 10);
  if (!LOJAS_VALIDAS.includes(loja)) throw httpErr(400, `Loja inválida. Use uma de: ${LOJAS_VALIDAS.join(", ")}`);
  if (!(ano >= 2020 && ano <= 2100)) throw httpErr(400, "Ano inválido.");
  if (!(mes >= 1 && mes <= 12)) throw httpErr(400, "Mês inválido (1–12).");
  return { loja, ano, mes };
}
function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
function salvarBruto(loja, ano, mes, originalname, buffer) {
  const dir = path.join(UPLOAD_DIR, loja, periodoSlug(ano, mes));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, originalname.replace(/[^\w.\-]+/g, "_"));
  fs.writeFileSync(dest, buffer);
  return dest;
}

// Fase 1: parseia o PDF (lança se a soma não bater) — ANTES de tocar no banco.
async function parseVendasFile(loja, ano, mes, file) {
  const savedPath = salvarBruto(loja, ano, mes, file.originalname, file.buffer);
  const parsed = await parseVendasPdf(savedPath);
  parsed.rows = parsed.rows.map((r) => ({ ...r, categoria: classificar(r.descricao) }));
  return parsed;
}
// Fase 2: grava (só chamada depois que tudo que podia falhar já passou).
function persistirVendas(periodoId, parsed) {
  replaceVendas(periodoId, parsed.rows);
  setVendasMeta(periodoId, {
    lastDay: parsed.lastDay,
    lastDayPartial: parsed.lastDayPartial,
    printedTotal: parsed.printedTotal,
    geradoEm: parsed.headerTimestamp,
  });
  return { linhas: parsed.rows.length, total: parsed.total, printedTotal: parsed.printedTotal, lastDayPartial: parsed.lastDayPartial };
}

function processarConcorrentes(periodoId, loja, ano, mes, file) {
  const savedPath = salvarBruto(loja, ano, mes, file.originalname, file.buffer);
  const vendas = getVendas(periodoId);
  const agg = vendas.length ? aggregate(vendas) : { precoMedioPorProduto: [] };
  const refDate = periodoSlug(ano, mes) + "-01";
  const { ofertas, resumo } = parseConcorrentes(savedPath, agg.precoMedioPorProduto, {
    referenceDate: new Date().toISOString().slice(0, 10) < refDate ? refDate : new Date().toISOString().slice(0, 10),
  });
  replaceConcorrencia(periodoId, ofertas);
  return { ofertas: ofertas.length, ...resumo };
}

const campos = upload.fields([
  { name: "vendas", maxCount: 1 },
  { name: "concorrentes", maxCount: 1 },
]);

app.post("/upload/analise", campos, async (req, res) => {
  try {
    const { loja, ano, mes } = validarLojaPeriodo(req.body);
    const vendasFile = req.files?.vendas?.[0];
    const concFile = req.files?.concorrentes?.[0];
    let instagram = null;
    if (req.body.instagram) {
      try {
        instagram = typeof req.body.instagram === "string" ? JSON.parse(req.body.instagram) : req.body.instagram;
      } catch {
        throw httpErr(400, "Campo 'instagram' não é JSON válido.");
      }
    }

    if (!vendasFile && !concFile && !instagram) throw httpErr(400, "Envie ao menos um dos: relatório de vendas, Instagram, concorrentes.");

    // se não há vendas ainda e nenhum PDF novo, o período precisa existir
    const jaExiste = findPeriodo(loja, ano, mes);
    if (!vendasFile && !jaExiste) throw httpErr(400, "Primeiro envio deste período precisa incluir o relatório de vendas (PDF).");

    // parseia o PDF ANTES de criar/alterar o período — se a soma não bater, nada é gravado
    const parsedVendas = vendasFile ? await parseVendasFile(loja, ano, mes, vendasFile) : null;

    const periodoId = getOrCreatePeriodo(loja, ano, mes);
    const resultado = { ok: true, loja, periodo: periodoSlug(ano, mes) };

    if (parsedVendas) resultado.vendas = persistirVendas(periodoId, parsedVendas);
    if (instagram) {
      const metricas = normalizeInstagram(instagram);
      replaceInstagram(periodoId, metricas);
      resultado.instagram = { metricas: metricas.length };
    }
    if (concFile) resultado.concorrentes = processarConcorrentes(periodoId, loja, ano, mes, concFile);

    res.json(resultado);
  } catch (e) {
    console.error("[upload/analise]", e.message);
    res.status(e.status || 500).json({ erro: e.message });
  }
});

// aliases individuais (fidelidade ao spec) — reusam os mesmos helpers
app.post("/upload/vendas", upload.single("arquivo"), async (req, res) => {
  try {
    const { loja, ano, mes } = validarLojaPeriodo(req.body);
    if (!req.file) throw httpErr(400, "Arquivo 'arquivo' (PDF) obrigatório.");
    const parsed = await parseVendasFile(loja, ano, mes, req.file);
    const periodoId = getOrCreatePeriodo(loja, ano, mes);
    res.json({ ok: true, vendas: persistirVendas(periodoId, parsed) });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

app.post("/upload/instagram", (req, res) => {
  try {
    const { loja, ano, mes } = validarLojaPeriodo(req.body);
    if (!findPeriodo(loja, ano, mes)) throw httpErr(400, "Período ainda não existe — envie o relatório de vendas primeiro.");
    const periodoId = getOrCreatePeriodo(loja, ano, mes);
    const metricas = normalizeInstagram(req.body.metricas || req.body);
    replaceInstagram(periodoId, metricas);
    res.json({ ok: true, instagram: { metricas: metricas.length } });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

app.post("/upload/concorrentes", upload.single("arquivo"), (req, res) => {
  try {
    const { loja, ano, mes } = validarLojaPeriodo(req.body);
    if (!req.file) throw httpErr(400, "Arquivo 'arquivo' (xlsx) obrigatório.");
    if (!findPeriodo(loja, ano, mes)) throw httpErr(400, "Período ainda não existe — envie o relatório de vendas primeiro.");
    const periodoId = getOrCreatePeriodo(loja, ano, mes);
    res.json({ ok: true, concorrentes: processarConcorrentes(periodoId, loja, ano, mes, req.file) });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message });
  }
});

// --- leitura -------------------------------------------------------------

const MESES_PT = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

app.get("/api/lojas", (req, res) => {
  res.json(
    LOJAS_VALIDAS.map((nome) => ({
      nome,
      endereco: LOJAS_CFG[nome]?.endereco || null,
      instagram: LOJAS_CFG[nome]?.instagram || null,
      campanhaNome: LOJAS_CFG[nome]?.campanhaNome || null,
    }))
  );
});

app.get("/api/periodos/:loja", (req, res) => {
  const loja = req.params.loja;
  if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
  res.json(listPeriodos(loja));
});

app.get("/api/analise/:loja/:periodo", (req, res) => {
  try {
    const loja = req.params.loja;
    if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
    const m = String(req.params.periodo).match(/^(\d{4})-(\d{2})$/);
    if (!m) return res.status(400).json({ erro: "período deve ser AAAA-MM" });
    const ano = +m[1];
    const mes = +m[2];

    const periodo = findPeriodo(loja, ano, mes);
    if (!periodo) return res.status(404).json({ erro: "sem análise para este período" });

    const lojaCfg = LOJAS_CFG[loja] || {};
    const vendas = getVendas(periodo.id);
    if (!vendas.length) return res.status(404).json({ erro: "período sem dados de vendas" });

    const agg = aggregate(vendas, {
      lastDay: periodo.vendas_ultimo_dia,
      lastDayPartial: !!periodo.vendas_ultimo_dia_parcial,
      diasCampanha: lojaCfg.diasCampanha || [],
    });
    const insights = gerarInsights(agg, lojaCfg);

    const igRows = getInstagram(periodo.id);
    const instagram = igRows.map((r) => ({
      label: r.rotulo,
      value: r.valor_exibicao,
      delta: r.delta_pct,
      extra: r.observacao || "",
    }));

    const concRows = getConcorrencia(periodo.id);
    let concorrencia;
    if (!concRows.length) {
      concorrencia = { pending: true, competitors: lojaCfg.concorrentes || [] };
    } else {
      const porConc = new Map();
      for (const o of concRows) {
        if (!porConc.has(o.concorrente))
          porConc.set(o.concorrente, { concorrente: o.concorrente, ofertas: 0, comparaveis: 0, abaixo: 0, confianca: { Alta: 0, Média: 0, Baixa: 0 }, exemplos: [] });
        const e = porConc.get(o.concorrente);
        e.ofertas++;
        if (o.abaixo_do_nosso != null) {
          e.comparaveis++;
          if (o.abaixo_do_nosso) e.abaixo++;
        }
        const nc = o.nivel_confianca || "";
        if (/alta/i.test(nc)) e.confianca.Alta++;
        else if (/m[eé]dia/i.test(nc)) e.confianca["Média"]++;
        else if (/baixa/i.test(nc)) e.confianca.Baixa++;
        if (o.abaixo_do_nosso && e.exemplos.length < 5)
          e.exemplos.push({ produto: o.produto, promo: o.preco_promo, nosso: o.nosso_preco_medio, confianca: o.nivel_confianca });
      }
      concorrencia = {
        pending: false,
        totalOfertas: concRows.length,
        comparaveis: concRows.filter((o) => o.abaixo_do_nosso != null).length,
        abaixoDoNosso: concRows.filter((o) => !!o.abaixo_do_nosso).length,
        porConcorrente: [...porConc.values()].sort((a, b) => b.abaixo - a.abaixo || b.ofertas - a.ofertas),
      };
    }

    res.json({
      loja,
      periodo: periodoSlug(ano, mes),
      meta: {
        periodoLabel: `${MESES_PT[mes]} de ${ano}`,
        endereco: lojaCfg.endereco || null,
        diaParcial: periodo.vendas_ultimo_dia_parcial
          ? { dia: periodo.vendas_ultimo_dia, geradoEm: periodo.vendas_fonte_gerada_em }
          : null,
        totalImpresso: periodo.vendas_total_impresso,
        fonteNota:
          'Faturamento e categorias a partir do relatório "Analítico de Vendas". Categoria de produto é estimada por palavra-chave na descrição — visão direcional, não substitui o cadastro oficial do sistema.',
        atualizadoEm: periodo.atualizado_em,
      },
      kpis: agg.kpis,
      daily: agg.daily,
      weekday: agg.weekday,
      categories: agg.categories,
      topProducts: agg.topProducts,
      extras: agg.extras,
      diversos: agg.diversos,
      insights,
      instagram,
      concorrencia,
    });
  } catch (e) {
    console.error("[api/analise]", e);
    res.status(500).json({ erro: e.message });
  }
});

// páginas + assets (atrás da sessão)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Vermelhinha Analytics em http://localhost:${PORT}`);
  console.log(`  upload:  http://localhost:${PORT}/upload.html`);
});
