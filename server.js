// Analytics — backend.
// Sobe os documentos brutos (relatório de vendas PDF, métricas do Instagram, planilha de
// concorrentes), o backend processa e serve o painel já validado, com histórico por
// loja/mês. Nunca lê nem escreve nada dentro de app_minasfarma/.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

// .env leve (sem dependência) — para SUPABASE_DB_URL, ANTHROPIC_API_KEY, etc.
try {
  for (const linha of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !linha.trimStart().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (e) {
  /* sem .env, tudo bem */
}

const {
  LOJAS_VALIDAS,
  getOrCreatePeriodo,
  findPeriodo,
  getPeriodoById,
  getFaturamento,
  getDiasComVenda,
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
const { ingestFile } = require("./ingest");
const { startWatcher, getLog } = require("./watcher");
const { validate: validateAnalise } = require("./validate-analise");
const analiseStore = require("./analise-store");
const { gerarAnalise, podeGerar, MODEL: ANALISE_MODEL } = require("./motor");
const { construirOntologia } = require("./ontologia");

const PORT = process.env.PORT || 4180;
const UPLOAD_DIR = path.join(__dirname, "data", "uploads");
const INBOX_DIR = process.env.VA_INBOX || path.join(__dirname, "inbox");
const POLL_MIN = Number(process.env.VA_POLL_MIN || 5);
const ANALISE_TOKEN = process.env.ANALISE_UPLOAD_TOKEN || null;
const LOJAS_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "lojas.json"), "utf8"));

// Site estático que se regenera (VA_PUBLIC_DIR — aponte p/ OneDrive/Drive/GitHub Pages/Netlify)
const PUBLIC_DIR = process.env.VA_PUBLIC_DIR || path.join(__dirname, "publico");
const publicar = require("./publicar");
const supabaseSync = require("./supabase-sync");
const { coletarTudo } = require("./coletar-tudo");
let _pubTimer = null;
let _pubRodando = false;
async function regenerarAgora() {
  if (_pubRodando) return;
  _pubRodando = true;
  try {
    const { B } = await coletarTudo({ port: PORT, cookie: makeToken() }); // coleta UMA vez
    const r = await publicar.regenerar({ outDir: PUBLIC_DIR, root: __dirname, B });
    if (r && r.arquivo) console.log(`  publico: analytics.html (${(r.bytes / 1048576).toFixed(1)} MB, ${r.lojas_com_dados} loja(s))`);
    // mantém as pastas de deploy estático em dia (Vercel/GitHub Pages servem o index.html)
    try {
      const src = path.join(PUBLIC_DIR, "index.html");
      for (const d of ["analytics"]) {
        const dst = path.join(__dirname, d);
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(src, path.join(dst, "index.html"));
        if (!fs.existsSync(path.join(dst, ".nojekyll"))) fs.writeFileSync(path.join(dst, ".nojekyll"), "");
      }
    } catch (e) { console.error("[publicar] cópia p/ analytics/:", e.message); }
    if (supabaseSync.ativo()) {
      const s = await supabaseSync.sincronizar({ B });
      if (s && s.linhas) console.log(`  supabase: ${s.linhas} snapshots enviados`);
    }
  } catch (e) {
    console.error("[publicar/supabase]", e.message);
  } finally {
    _pubRodando = false;
  }
}
function regenerarPublicoEmBreve(ms = 4000) {
  clearTimeout(_pubTimer);
  _pubTimer = setTimeout(() => { regenerarAgora(); }, ms);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- auth (usuário + senha, ferramenta interna) ----------------------------

let APP_PASSWORD = process.env.APP_PASSWORD || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const USUARIOS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config", "usuarios.json"), "utf8")).usuarios || {};
  } catch {
    return {};
  }
})();
function autentica(usuario, senha) {
  senha = String(senha || "");
  if (senha && senha === APP_PASSWORD) return usuario || "admin";
  const u = String(usuario || "").trim();
  if (u && USUARIOS[u] != null && String(USUARIOS[u]) === senha) return u;
  // também aceita "usuario" digitado no campo senha (compat com o login antigo só-senha)
  for (const [nome, pw] of Object.entries(USUARIOS)) if (String(pw) === senha) return nome;
  return null;
}

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

const LOGIN_PAGE = (erro) => `<!doctype html><meta charset="utf-8"><title>Entrar — Analytics</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#1f2430;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:min(340px,90vw)}
h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 20px;color:#8a909c;font-size:13px}
input{width:100%;padding:10px 12px;border:1px solid #e0e3e8;border-radius:8px;font-size:15px;box-sizing:border-box}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#d81f2a;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#d81f2a;font-size:13px;margin-top:10px}</style>
<form method="post" action="/login">
<h1>Analytics</h1><p class="sub">Minas Farma · Farma e Farma</p>
<input type="text" name="usuario" placeholder="Usuário" autofocus autocomplete="username" style="margin-bottom:10px">
<input type="password" name="senha" placeholder="Senha" autocomplete="current-password">
<button type="submit">Entrar</button>
${erro ? '<div class="err">Usuário ou senha incorretos.</div>' : ""}
</form>`;

app.get("/healthz", (req, res) => res.json({ ok: true, lojas: LOJAS_VALIDAS }));
app.get("/login", (req, res) => res.type("html").send(LOGIN_PAGE(req.query.erro)));
app.post("/login", (req, res) => {
  const quem = autentica(req.body.usuario, req.body.senha);
  if (quem) {
    res.setHeader("Set-Cookie", `va_session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return res.redirect("/");
  }
  res.redirect("/login?erro=1");
});
app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "va_session=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/login");
});

// cópia estática que se regenera — UM arquivo com as duas lojas e todas as telas, servido
// SEM login (é o artefato "público"; o mesmo que você copia p/ OneDrive/Drive/GitHub Pages).
// Fica antes do gate de sessão de propósito.
app.use("/publico", express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.get(["/publico", "/publico/"], (req, res) => res.sendFile(path.join(PUBLIC_DIR, "analytics.html")));

// tudo abaixo exige sessão (VA_NO_AUTH=1 desliga — só para teste local, nunca em produção)
const NO_AUTH = process.env.VA_NO_AUTH === "1";
if (NO_AUTH) console.warn("  ⚠  VA_NO_AUTH=1 — autenticação DESLIGADA (use só localmente).");
app.use((req, res, next) => {
  if (NO_AUTH) return next();
  // a tarefa agendada externa posta aqui com token próprio (X-Analise-Token), sem sessão
  if (req.method === "POST" && req.path === "/analise-comercial/upload") return next();
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
  const closingHour = LOJAS_CFG[loja]?.horaFechamento ?? 22;
  const parsed = await parseVendasPdf(savedPath, { closingHour });
  parsed.rows = parsed.rows.map((r) => ({ ...r, categoria: classificar(r.descricao) }));
  return parsed;
}
// Fase 2: grava (só chamada depois que tudo que podia falhar já passou).
function persistirVendas(periodoId, parsed, loja) {
  replaceVendas(periodoId, parsed.rows);
  setVendasMeta(periodoId, {
    lastDay: parsed.lastDay,
    lastDayPartial: parsed.lastDayPartial,
    lastDayMotivo: parsed.lastDayMotivo,
    printedTotal: parsed.printedTotal,
    geradoEm: parsed.headerTimestamp,
  });
  // Fase 1/4: mesmo caminho do watcher — mantém catálogo (EAN) e cesta em dia também no
  // upload manual (antes só o watcher da inbox fazia isso).
  let catalogo = null;
  try {
    catalogo = require("./catalogo").sincronizarProdutosDeVendas(periodoId);
  } catch (e) {
    console.error("[upload] sincronização de catálogo:", e.message);
  }
  if (loja) {
    try {
      require("./basket").calcularCesta(loja);
    } catch (e) {
      console.error("[upload] cesta:", e.message);
    }
    try {
      require("./intelligence").rodarDeteccao(loja);
    } catch (e) {
      console.error("[upload] detecção de sinais:", e.message);
    }
  }
  return {
    linhas: parsed.rows.length,
    total: parsed.total,
    printedTotal: parsed.printedTotal,
    lastDayPartial: parsed.lastDayPartial,
    lastDayMotivo: parsed.lastDayMotivo,
    catalogo,
  };
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
  // concorrência mexe no COMPETITOR_PRICE_ATTACK e no Opportunity Score — re-detecta
  try {
    require("./intelligence").rodarDeteccao(loja);
  } catch (e) {
    console.error("[upload/concorrentes] detecção:", e.message);
  }
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

    if (parsedVendas) resultado.vendas = persistirVendas(periodoId, parsedVendas, loja);
    if (instagram) {
      const metricas = normalizeInstagram(instagram);
      replaceInstagram(periodoId, metricas);
      resultado.instagram = { metricas: metricas.length };
    }
    if (concFile) resultado.concorrentes = processarConcorrentes(periodoId, loja, ano, mes, concFile);

    if (parsedVendas) {
      try {
        require("./motor").maybeAutoAnalise({ tipo: "vendas", meses: [{ loja, periodo: periodoSlug(ano, mes) }] });
      } catch (e) {
        console.error("[upload/analise] auto-análise:", e.message);
      }
    }

    regenerarPublicoEmBreve();
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
    const out = persistirVendas(periodoId, parsed, loja);
    regenerarPublicoEmBreve();
    res.json({ ok: true, vendas: out });
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
    regenerarPublicoEmBreve();
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
    const r = processarConcorrentes(periodoId, loja, ano, mes, req.file);
    regenerarPublicoEmBreve();
    res.json({ ok: true, concorrentes: r });
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
      campanhas: LOJAS_CFG[nome]?.campanhas || [],
    }))
  );
});

app.get("/api/periodos/:loja", (req, res) => {
  const loja = req.params.loja;
  if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
  const agora = new Date();
  const mesCorrente = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;
  res.json(listPeriodos(loja).map((p) => ({ ...p, atual: p.periodo === mesCorrente })));
});

// eventos da pasta inbox/ (o que foi ingerido, quando, e o que falhou)
app.get("/api/ingest-log", (req, res) => res.json({ inbox: INBOX_DIR, pollMin: POLL_MIN, eventos: getLog() }));

// aba Concorrentes — comparação automática + análise
const concAnalise = require("./concorrencia-analise");
const { bestMatch: _bmConc } = require("./match");
const _db = require("./db");

app.get("/api/concorrencia/:loja", (req, res) => {
  if (!LOJAS_VALIDAS.includes(req.params.loja)) return res.status(404).json({ erro: "loja desconhecida" });
  try {
    res.json(concAnalise.analisarConcorrencia(req.params.loja));
  } catch (e) {
    console.error("[api/concorrencia]", e);
    res.status(500).json({ erro: e.message });
  }
});

// período mais recente da loja que tem vendas
function periodoRecente(loja) {
  const ps = listPeriodos(loja).filter((p) => p.temVendas);
  if (!ps.length) return null;
  const p = ps.find((x) => x.atual) || ps[0];
  return findPeriodo(loja, p.ano, p.mes);
}
// cruza uma lista de ofertas {produto, preco_promo, marca?} com o nosso preço médio praticado
function crossarOfertas(per, ofertas) {
  const cands = aggregate(getVendas(per.id)).precoMedioPorProduto
    .filter((p) => p.precoMedio != null)
    .map((p) => ({ name: p.name, precoMedio: p.precoMedio }));
  return ofertas.map((o) => {
    const m = cands.length ? _bmConc(String(o.produto), cands, { minScore: 0.45, minOverlap: 2, brand: o.marca }) : null;
    const nosso = m ? m.match.precoMedio : null;
    return {
      ...o,
      status_validacao: "Confirmada",
      nivel_confianca: o.nivel_confianca || "Média",
      produto_casado: m ? m.match.name : null,
      nosso_preco_medio: nosso,
      abaixo_do_nosso: o.preco_promo != null && nosso != null ? o.preco_promo < nosso : null,
    };
  });
}
// "PRODUTO ... R$ 12,90" por linha -> [{produto, preco_promo}]
function parseEncarteTexto(texto) {
  const out = [];
  for (const linhaRaw of String(texto || "").split(/\r?\n/)) {
    const linha = linhaRaw.trim();
    if (linha.length < 4) continue;
    const m = linha.match(/^(.+?)[\s.:–-]*(?:r\$|por|apenas|só|:)?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2}|\d+)\s*$/i);
    if (!m) continue;
    let nome = m[1].replace(/[•\-–*·>]+/g, " ").replace(/\s{2,}/g, " ").trim();
    nome = nome.replace(/\b(de|por|apenas|so|só|preço|preco|oferta|promo(cao|ção)?)\b\s*$/i, "").trim();
    if (nome.length < 3) continue;
    const preco = parseFloat(m[2].replace(/\.(?=\d{3})/g, "").replace(",", "."));
    if (!Number.isFinite(preco) || preco <= 0 || preco > 100000) continue;
    out.push({ produto: nome, preco_promo: Math.round(preco * 100) / 100 });
  }
  return out;
}

function _posDeteccaoConc(loja) {
  try { require("./intelligence").rodarDeteccao(loja); } catch (e) { console.error("[conc] detecção:", e.message); }
  regenerarPublicoEmBreve();
}

// adiciona ofertas de concorrente à mão (uma ou várias). Vale para as DUAS lojas.
app.post("/api/concorrencia/:loja/ofertas", express.json({ limit: "512kb" }), (req, res) => {
  if (!LOJAS_VALIDAS.includes(req.params.loja)) return res.status(404).json({ erro: "loja desconhecida" });
  const b = req.body || {};
  const base = Array.isArray(b.ofertas) ? b.ofertas : (b.produto ? [b] : []);
  if (!base.length) return res.status(400).json({ erro: "envie 'ofertas' (array) ou uma oferta única com 'produto' e 'preco_promo'" });
  const limpas = base
    .map((o) => ({
      concorrente: String(o.concorrente || b.concorrente || "").trim(),
      categoria: (o.categoria || b.categoria || null),
      produto: String(o.produto || "").trim(),
      marca: o.marca || null,
      preco_promo: o.preco_promo != null ? Number(o.preco_promo) : null,
      preco_normal: o.preco_normal != null ? Number(o.preco_normal) : null,
      validade: o.validade || b.validade || null,
      nivel_confianca: o.nivel_confianca || b.nivel_confianca || "Média",
    }))
    .filter((o) => o.concorrente && o.produto && o.preco_promo > 0);
  if (!limpas.length) return res.status(400).json({ erro: "nenhuma oferta válida (precisa de concorrente + produto + preço)" });

  const aplicadas = [];
  for (const loja of LOJAS_VALIDAS) {
    const per = periodoRecente(loja);
    if (!per) continue;
    _db.adicionarOfertasConc(per.id, crossarOfertas(per, limpas));
    aplicadas.push({ loja, ofertas: limpas.length });
    _posDeteccaoConc(loja);
  }
  res.json({ ok: true, aplicadas, ofertas: limpas.length });
});

// só interpreta o texto colado de um encarte/post — NÃO salva (o usuário revê e confirma)
app.post("/api/concorrencia/:loja/colar", express.json({ limit: "512kb" }), (req, res) => {
  if (!LOJAS_VALIDAS.includes(req.params.loja)) return res.status(404).json({ erro: "loja desconhecida" });
  const b = req.body || {};
  const linhas = parseEncarteTexto(b.texto);
  const per = periodoRecente(req.params.loja);
  const draft = per ? crossarOfertas(per, linhas.map((l) => ({ ...l, concorrente: b.concorrente || "", categoria: b.categoria || null }))) : linhas;
  res.json({ ok: true, encontradas: draft.length, ofertas: draft });
});

// força a regeneração da cópia estática + o envio pro Supabase agora
// (normalmente é automático após cada ingestão)
app.post("/api/publicar", async (req, res) => {
  try {
    const { B } = await coletarTudo({ port: PORT, cookie: makeToken() });
    const r = await publicar.regenerar({ outDir: PUBLIC_DIR, root: __dirname, B });
    let supabase = { pulado: "SUPABASE_DB_URL não definida" };
    if (supabaseSync.ativo()) {
      try {
        supabase = await supabaseSync.sincronizar({ B });
      } catch (e) {
        supabase = { erro: e.message };
      }
    }
    res.json({ ok: true, dir: PUBLIC_DIR, ...r, supabase });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// --- Fase 1: catálogo (produtos por EAN) + freshness de estoque/custo/preço ---
const dbCat = require("./db");

app.get("/api/catalogo/:loja", (req, res) => {
  const loja = req.params.loja;
  if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
  res.json({
    loja,
    contagem: dbCat.contagemCatalogo(),
    freshness: dbCat.freshnessCatalogo(loja),
    faltando: (() => {
      const f = dbCat.freshnessCatalogo(loja);
      const falta = [];
      if (!f.estoque.ultima) falta.push("estoque");
      if (!f.custo.ultima) falta.push("custo");
      if (!f.preco.ultima) falta.push("preço");
      return falta;
    })(),
  });
});

app.get("/api/catalogo/:loja/produtos", (req, res) => {
  if (!LOJAS_VALIDAS.includes(req.params.loja)) return res.status(404).json({ erro: "loja desconhecida" });
  res.json(dbCat.listProdutos({ categoria: req.query.categoria, semEan: req.query.sem_ean === "1", q: req.query.q, limite: +req.query.limite || 500 }));
});

app.post("/api/catalogo/produtos/:id", (req, res) => {
  const id = +req.params.id;
  if (!id) return res.status(400).json({ erro: "id inválido" });
  const p = dbCat.getProdutoPorId(id);
  if (!p) return res.status(404).json({ erro: "produto não encontrado" });
  const campos = {};
  for (const k of ["descricao_manual", "marca_manual", "categoria_manual", "subcategoria_manual", "ativo"]) {
    if (k in req.body) campos[k] = req.body[k];
  }
  res.json(dbCat.produtoEfetivo(dbCat.setProdutoOverride(id, campos)));
});

// --- Fase 2/3/4: Marketing Intelligence (camada determinística; a IA não entra aqui) ---
const mpa = require("./marketing-product-analytics");
const basket = require("./basket");
const campanhasEng = require("./campanhas");

// contexto opcional que enriquece o Opportunity Score: pressão de concorrência + cesta
function contextoMarketing(loja, ym) {
  const ctx = {};
  const m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
  let per = m ? findPeriodo(loja, +m[1], +m[2]) : null;
  if (!per) {
    const ps = listPeriodos(loja);
    if (ps.length) per = findPeriodo(loja, ps[0].ano, ps[0].mes);
  }
  if (per) {
    const conc = getConcorrencia(per.id);
    if (conc.length) {
      const cats = new Set();
      for (const o of conc) if (o.abaixo_do_nosso && o.categoria) cats.add(o.categoria);
      ctx.concorrenciaCategorias = cats;
    }
  }
  try {
    const c = basket.centralidade(loja);
    if (c && c.size) ctx.cestaCentralidade = c;
  } catch (e) {}
  return ctx;
}

function lojaOk(req, res) {
  if (!LOJAS_VALIDAS.includes(req.params.loja)) {
    res.status(404).json({ erro: "loja desconhecida" });
    return false;
  }
  return true;
}

app.get("/api/marketing/:loja/:periodo/produtos", (req, res) => {
  if (!lojaOk(req, res)) return;
  const ctx = contextoMarketing(req.params.loja, req.params.periodo);
  const r = mpa.analisarProdutos(req.params.loja, ctx);
  if (r.erro) return res.status(404).json(r);
  let lista = r.produtos;
  if (req.query.classe) lista = lista.filter((p) => p.classe === req.query.classe);
  if (req.query.categoria) lista = lista.filter((p) => p.categoria === req.query.categoria);
  if (req.query.limite) lista = lista.slice(0, +req.query.limite);
  res.json({ ...r, produtos: lista, total_catalogo: r.total });
});

// análise cruzada — vendas × estoque × custo × margem -> o que sai e dá lucro, o que encalha
const analiseCruzada = require("./analise-cruzada");
app.get("/api/marketing/:loja/:periodo/resultado", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const ctx = contextoMarketing(req.params.loja, req.params.periodo);
    const r = analiseCruzada.analiseCruzada(req.params.loja, ctx);
    res.status(r.erro ? 404 : 200).json(r);
  } catch (e) {
    console.error("[api/marketing resultado]", e);
    res.status(500).json({ erro: e.message });
  }
});

app.get("/api/marketing/:loja/:periodo/recommended-products", (req, res) => {
  if (!lojaOk(req, res)) return;
  const ctx = contextoMarketing(req.params.loja, req.params.periodo);
  const r = mpa.recomendados(req.params.loja, { ...ctx, limite: +req.query.limite || 40 });
  res.status(r.erro ? 404 : 200).json(r);
});

app.get("/api/marketing/:loja/:periodo/do-not-promote", (req, res) => {
  if (!lojaOk(req, res)) return;
  const ctx = contextoMarketing(req.params.loja, req.params.periodo);
  const r = mpa.naoAnunciar(req.params.loja, ctx);
  res.status(r.erro ? 404 : 200).json(r);
});

app.get("/api/marketing/:loja/:periodo/stagnant-stock", (req, res) => {
  if (!lojaOk(req, res)) return;
  const ctx = contextoMarketing(req.params.loja, req.params.periodo);
  const r = mpa.estoqueParado(req.params.loja, ctx);
  res.status(r.erro ? 404 : 200).json(r);
});

app.get("/api/marketing/:loja/:periodo/products/:ean", (req, res) => {
  if (!lojaOk(req, res)) return;
  const ctx = contextoMarketing(req.params.loja, req.params.periodo);
  const r = mpa.produtoPorEan(req.params.loja, req.params.ean, ctx);
  res.status(r.erro ? 404 : 200).json(r);
});

// Fase 4 — cesta
app.get("/api/marketing/:loja/:periodo/baskets", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const r = basket.calcularCesta(req.params.loja, { janelaDias: +req.query.janela || undefined });
    res.status(r.erro ? 422 : 200).json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get("/api/marketing/:loja/:periodo/combos", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const ctx = contextoMarketing(req.params.loja, req.params.periodo);
    res.json(basket.combos(req.params.loja, { ...ctx, limite: +req.query.limite || 60 }));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Fase 3 — campanhas: eficiência, builder, simulador
app.get("/api/marketing/:loja/campaign-efficiency", (req, res) => {
  if (!lojaOk(req, res)) return;
  const janelaDias = +req.query.janela || undefined;
  if (req.query.nome) return res.json(campanhasEng.eficienciaCalendario(req.params.loja, { nome: req.query.nome, janelaDias }));
  res.json({ loja: req.params.loja, campanhas: campanhasEng.eficienciaTodasDoCalendario(req.params.loja, { janelaDias }) });
});

app.get("/api/marketing/:loja/:periodo/campaign-builder", (req, res) => {
  if (!lojaOk(req, res)) return;
  const ctx = contextoMarketing(req.params.loja, req.params.periodo);
  const categorias = req.query.categorias ? String(req.query.categorias).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const r = campanhasEng.campaignBuilder(req.params.loja, { ...ctx, objetivo: req.query.objetivo, categorias });
  res.status(r.erro ? 404 : 200).json(r);
});

app.post("/api/marketing/:loja/offer-simulator", express.json({ limit: "1mb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const r = campanhasEng.offerSimulator(req.params.loja, req.body || {});
    res.status(r.erro ? 400 : 200).json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// CRUD leve de campanhas persistidas
app.get("/api/marketing/:loja/campaigns", (req, res) => {
  if (!lojaOk(req, res)) return;
  res.json(dbCat.listCampanhas(req.params.loja));
});
app.get("/api/marketing/:loja/campaigns/:id", (req, res) => {
  if (!lojaOk(req, res)) return;
  const c = dbCat.getCampanha(+req.params.id);
  if (!c || c.loja !== req.params.loja) return res.status(404).json({ erro: "campanha não encontrada" });
  res.json(c);
});
app.post("/api/marketing/:loja/campaigns", express.json({ limit: "1mb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  const b = req.body || {};
  if (!b.nome) return res.status(400).json({ erro: "nome obrigatório" });
  const id = dbCat.criarCampanha(req.params.loja, b);
  for (const p of b.produtos || []) if (p.produto_id) dbCat.addCampanhaProduto(id, p);
  res.json(dbCat.getCampanha(id));
});
app.patch("/api/marketing/:loja/campaigns/:id", express.json({ limit: "1mb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  const c = dbCat.getCampanha(+req.params.id);
  if (!c || c.loja !== req.params.loja) return res.status(404).json({ erro: "campanha não encontrada" });
  res.json(dbCat.atualizarCampanha(+req.params.id, req.body || {}));
});
app.delete("/api/marketing/:loja/campaigns/:id", (req, res) => {
  if (!lojaOk(req, res)) return;
  const c = dbCat.getCampanha(+req.params.id);
  if (!c || c.loja !== req.params.loja) return res.status(404).json({ erro: "campanha não encontrada" });
  dbCat.removerCampanha(+req.params.id);
  res.json({ ok: true });
});

// --- Fases 5–12: camada de Inteligência (detectores + War Room + investigação + decisão + padrões + ontologia + ask + editorial) ---
const intel = require("./intelligence");
const investigar = require("./intelligence/investigar");
const padroesEng = require("./intelligence/padroes");
const ontologia2 = require("./intelligence/ontologia2");
const askEng = require("./ask");
const editorialEng = require("./editorial");

function ctxOntologia(loja, ym) {
  const m = String(ym || "").match(/^(\d{4})-(\d{2})$/);
  let per = m ? findPeriodo(loja, +m[1], +m[2]) : null;
  if (!per) {
    const ps = listPeriodos(loja).filter((p) => p.temVendas);
    if (ps.length) per = findPeriodo(loja, ps[0].ano, ps[0].mes);
  }
  if (!per) return null;
  return {
    periodo: `${per.ano}-${String(per.mes).padStart(2, "0")}`,
    vendasRows: getVendas(per.id),
    concRows: getConcorrencia(per.id),
    lojaCfg: LOJAS_CFG[loja] || {},
    analiseComercial: analiseStore.read(loja, `${per.ano}-${String(per.mes).padStart(2, "0")}`),
  };
}

app.get("/api/intelligence/:loja/war-room", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    res.json(intel.warRoom(req.params.loja));
  } catch (e) {
    console.error("[war-room]", e);
    res.status(500).json({ erro: e.message });
  }
});

app.post("/api/intelligence/:loja/detect", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    res.json(intel.rodarDeteccao(req.params.loja, { persistir: req.query.dry !== "1" }));
  } catch (e) {
    console.error("[detect]", e);
    res.status(500).json({ erro: e.message });
  }
});

// "Palantir": sinais cruzados entre si -> decisões recomendadas (ação + efeito + evidências)
app.get("/api/intelligence/:loja/recommendations", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    res.json(intel.recomendarDecisoes(req.params.loja));
  } catch (e) {
    console.error("[recommendations]", e);
    res.status(500).json({ erro: e.message });
  }
});

app.get("/api/intelligence/:loja/signals", (req, res) => {
  if (!lojaOk(req, res)) return;
  res.json(dbCat.listSinais(req.params.loja, { status: req.query.status, classe: req.query.classe, tipo: req.query.tipo, limite: +req.query.limite || 200 }));
});
app.get("/api/intelligence/:loja/signals/:id", (req, res) => {
  if (!lojaOk(req, res)) return;
  const s = dbCat.getSinal(+req.params.id);
  if (!s) return res.status(404).json({ erro: "sinal não encontrado" });
  res.json(s);
});
app.patch("/api/intelligence/:loja/signals/:id", express.json({ limit: "256kb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    res.json(dbCat.setSinalStatus(+req.params.id, String(req.body.status || "")));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// Fase 6 — investigação
app.post("/api/intelligence/:loja/investigate", express.json({ limit: "256kb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const b = req.body || {};
    const r = b.gravar
      ? investigar.investigarEGravar(req.params.loja, { pergunta: b.pergunta, sinalId: b.sinalId })
      : investigar.investigar(req.params.loja, { pergunta: b.pergunta, sinalId: b.sinalId });
    res.status(r && r.erro ? 404 : 200).json(r);
  } catch (e) {
    console.error("[investigate]", e);
    res.status(500).json({ erro: e.message });
  }
});
app.get("/api/intelligence/:loja/investigations", (req, res) => {
  if (!lojaOk(req, res)) return;
  res.json(dbCat.listInvestigacoes(req.params.loja));
});
app.get("/api/intelligence/:loja/investigations/:id", (req, res) => {
  if (!lojaOk(req, res)) return;
  const i = dbCat.getInvestigacao(+req.params.id);
  if (!i) return res.status(404).json({ erro: "investigação não encontrada" });
  res.json(i);
});

// Fase 9 — decisões / ações / resultados
app.get("/api/intelligence/:loja/decisions", (req, res) => {
  if (!lojaOk(req, res)) return;
  res.json(dbCat.listDecisoes(req.params.loja));
});
app.get("/api/intelligence/:loja/decisions/:id", (req, res) => {
  if (!lojaOk(req, res)) return;
  const d = dbCat.getDecisao(+req.params.id);
  if (!d || d.loja !== req.params.loja) return res.status(404).json({ erro: "decisão não encontrada" });
  res.json({ ...d, semelhantes: padroesEng.semelhantes(req.params.loja, { sinalTipos: (d.sinais || []).map((sid) => { const s = dbCat.getSinal(+sid); return s && s.tipo; }).filter(Boolean), tipoDecisao: d.tipo }) });
});
app.post("/api/intelligence/:loja/decisions", express.json({ limit: "512kb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  const b = req.body || {};
  if (!b.titulo) return res.status(400).json({ erro: "titulo obrigatório" });
  const id = dbCat.criarDecisao(req.params.loja, b);
  res.json(dbCat.getDecisao(id));
});
app.post("/api/intelligence/:loja/decisions/:id/outcomes", express.json({ limit: "256kb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  const d = dbCat.getDecisao(+req.params.id);
  if (!d || d.loja !== req.params.loja) return res.status(404).json({ erro: "decisão não encontrada" });
  dbCat.addResultado(+req.params.id, req.body || {});
  const padrao = padroesEng.aprenderComDecisao(+req.params.id);
  res.json({ decisao: dbCat.getDecisao(+req.params.id), padrao });
});
app.patch("/api/intelligence/:loja/actions/:id", express.json({ limit: "128kb" }), (req, res) => {
  if (!lojaOk(req, res)) return;
  dbCat.setAcaoStatus(+req.params.id, String((req.body || {}).status || "pendente"));
  res.json({ ok: true });
});

// Fase 10 — padrões
app.get("/api/intelligence/:loja/patterns", (req, res) => {
  if (!lojaOk(req, res)) return;
  res.json(padroesEng.panorama(req.params.loja));
});

// Fase 7 — ontologia persistida
app.get("/api/intelligence/:loja/ontology", (req, res) => {
  if (!lojaOk(req, res)) return;
  res.json(dbCat.getOntologiaPersistida(req.params.loja));
});
app.post("/api/intelligence/:loja/ontology/sync", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const c = ctxOntologia(req.params.loja, req.query.periodo);
    if (!c) return res.status(404).json({ erro: "sem período com vendas" });
    res.json(ontologia2.sincronizarOntologia(req.params.loja, c.periodo, c));
  } catch (e) {
    console.error("[ontology/sync]", e);
    res.status(500).json({ erro: e.message });
  }
});

// Fase 11 — Ask Analytics
app.post("/api/intelligence/:loja/ask", express.json({ limit: "256kb" }), async (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const r = await askEng.perguntar(req.params.loja, { pergunta: (req.body || {}).pergunta });
    res.status(r && r.erro ? 400 : 200).json(r);
  } catch (e) {
    console.error("[ask]", e);
    res.status(500).json({ erro: e.message });
  }
});

// Fase 12 — Editorial (pauta 7 dias)
app.get("/api/intelligence/:loja/editorial-plan", (req, res) => {
  if (!lojaOk(req, res)) return;
  try {
    const r = editorialEng.planoSemanal(req.params.loja, { inicio: req.query.inicio });
    res.status(r && r.erro ? 404 : 200).json(r);
  } catch (e) {
    console.error("[editorial-plan]", e);
    res.status(500).json({ erro: e.message });
  }
});

// --- Fase 2: Motor de Análise Comercial (o backend só recebe/valida/guarda/serve o JSON) ---

// recebe o JSON gerado pela tarefa agendada externa (Cowork/rotina)
app.post("/analise-comercial/upload", express.json({ limit: "2mb" }), (req, res) => {
  if (ANALISE_TOKEN && req.get("X-Analise-Token") !== ANALISE_TOKEN) {
    return res.status(401).json({ erro: "token ausente ou inválido (header X-Analise-Token)" });
  }
  const doc = req.body;
  const { ok, erros } = validateAnalise(doc);
  const loja = doc && doc.meta && doc.meta.loja;
  const ym = String((doc && doc.meta && doc.meta.periodo && doc.meta.periodo.inicio) || "").slice(0, 7);
  if (!ok) {
    if (LOJAS_VALIDAS.includes(loja) && /^\d{4}-\d{2}$/.test(ym)) analiseStore.saveErro(loja, ym, erros, doc);
    console.warn(`[analise-comercial] recusado (${loja || "?"}/${ym || "?"}):`, erros.slice(0, 3).join("; "));
    return res.status(422).json({ erro: "JSON não passou na validação — análise anterior mantida", detalhes: erros });
  }
  const f = analiseStore.save(loja, ym, doc);
  console.log(`[analise-comercial] gravado ${loja}/${ym}`);
  res.json({ ok: true, loja, periodo: ym, arquivo: path.basename(f) });
});

app.get("/api/analise-comercial/:loja", (req, res) => {
  const loja = req.params.loja;
  if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
  const l = analiseStore.latest(loja);
  if (!l || !l.doc) return res.status(404).json({ erro: "nenhuma análise comercial para esta loja ainda", podeGerar: podeGerar(), model: ANALISE_MODEL });
  res.json({ loja, periodo: l.ym, meses: analiseStore.listMeses(loja), analise: l.doc, podeGerar: podeGerar(), model: ANALISE_MODEL });
});

app.get("/api/analise-comercial/:loja/:ym", (req, res) => {
  const loja = req.params.loja;
  if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
  if (!/^\d{4}-\d{2}$/.test(req.params.ym)) return res.status(400).json({ erro: "período deve ser AAAA-MM" });
  const doc = analiseStore.read(loja, req.params.ym);
  if (!doc) return res.status(404).json({ erro: "sem análise comercial para este período", podeGerar: podeGerar(), model: ANALISE_MODEL });
  res.json({ loja, periodo: req.params.ym, meses: analiseStore.listMeses(loja), analise: doc, podeGerar: podeGerar(), model: ANALISE_MODEL });
});

// ontologia — grafo de objetos interligados (tela "Conexões")
app.get("/api/ontologia/:loja/:periodo", (req, res) => {
  try {
    const loja = req.params.loja;
    if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
    const m = String(req.params.periodo).match(/^(\d{4})-(\d{2})$/);
    if (!m) return res.status(400).json({ erro: "período deve ser AAAA-MM" });
    const periodo = findPeriodo(loja, +m[1], +m[2]);
    if (!periodo) return res.status(404).json({ erro: "sem dados para este período" });
    const vendasRows = getVendas(periodo.id);
    if (!vendasRows.length) return res.status(404).json({ erro: "período sem vendas" });
    const grafo = construirOntologia({
      loja,
      periodo: req.params.periodo,
      vendasRows,
      concRows: getConcorrencia(periodo.id),
      lojaCfg: LOJAS_CFG[loja] || {},
      analiseComercial: analiseStore.read(loja, req.params.periodo),
    });
    res.json(grafo);
  } catch (e) {
    console.error("[api/ontologia]", e);
    res.status(500).json({ erro: e.message });
  }
});

// gerar sob demanda (botão "Gerar análise agora") — usa a API da Anthropic
let gerando = new Set();
app.post("/analise-comercial/gerar/:loja/:ym", async (req, res) => {
  const loja = req.params.loja;
  if (!LOJAS_VALIDAS.includes(loja)) return res.status(404).json({ erro: "loja desconhecida" });
  const m = String(req.params.ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return res.status(400).json({ erro: "período deve ser AAAA-MM" });
  const key = `${loja}/${req.params.ym}`;
  if (gerando.has(key)) return res.status(409).json({ erro: "já está gerando esta análise" });
  gerando.add(key);
  try {
    const r = await gerarAnalise(loja, +m[1], +m[2]);
    res.json(r);
  } catch (e) {
    console.error("[analise-comercial/gerar]", e.message);
    res.status(e.code === "SEM_CHAVE" ? 400 : 500).json({ erro: e.message, code: e.code || null });
  } finally {
    gerando.delete(key);
  }
});

function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

// Monta a resposta completa da análise. Retorna { status, body }.
function buildAnalise(loja, ano, mes) {
  if (!LOJAS_VALIDAS.includes(loja)) return { status: 404, body: { erro: "loja desconhecida" } };
  const periodo = findPeriodo(loja, ano, mes);
  if (!periodo) return { status: 404, body: { erro: "sem análise para este período" } };

  const agora = new Date();
  const ehMesCorrente = ano === agora.getFullYear() && mes === agora.getMonth() + 1;

  const lojaCfg = LOJAS_CFG[loja] || {};
  const vendas = getVendas(periodo.id);
  if (!vendas.length) return { status: 404, body: { erro: "período sem dados de vendas" } };

  const agg = aggregate(vendas, {
    lastDay: periodo.vendas_ultimo_dia,
    lastDayPartial: !!periodo.vendas_ultimo_dia_parcial,
  });
  const insights = gerarInsights(agg, lojaCfg, vendas);

  // variação vs. mês anterior — só compara se o mês anterior estiver "cheio" (evita
  // comparar agosto inteiro contra um julho que só tem um pedaço de dados).
  const prevMes = mes === 1 ? 12 : mes - 1;
  const prevAno = mes === 1 ? ano - 1 : ano;
  const prevPer = findPeriodo(loja, prevAno, prevMes);
  let fatAnterior = null;
  let varPct = null;
  if (prevPer) {
    const diasNoMes = new Date(prevAno, prevMes, 0).getDate();
    const diasComVenda = getDiasComVenda(prevPer.id);
    const cheio = !prevPer.vendas_ultimo_dia_parcial && diasComVenda >= diasNoMes - 3;
    if (cheio) {
      fatAnterior = getFaturamento(prevPer.id);
      varPct = fatAnterior ? Math.round(((agg.kpis.faturamento - fatAnterior) / fatAnterior) * 1000) / 10 : null;
    }
  }
  agg.kpis.faturamentoMesAnterior = fatAnterior;
  agg.kpis.varFaturamentoPct = varPct;

  const instagram = getInstagram(periodo.id).map((r) => ({
    label: r.rotulo, value: r.valor_exibicao, delta: r.delta_pct, extra: r.observacao || "",
  }));

  const concRows = getConcorrencia(periodo.id);
  const cfgConc = lojaCfg.concorrentes || [];
  let concorrencia;
  if (!concRows.length) {
    concorrencia = { pending: true, competitors: cfgConc };
  } else {
    // começa por TODOS os concorrentes configurados; preenche o que a coleta trouxe.
    const porConc = new Map();
    for (const c of cfgConc) {
      porConc.set(norm(c.nome), { concorrente: c.nome, handle: c.handle || null, nota: c.nota || null,
        temColeta: false, ofertas: 0, comparaveis: 0, abaixo: 0, confianca: { Alta: 0, "Média": 0, Baixa: 0 }, exemplos: [] });
    }
    for (const o of concRows) {
      const key = norm(o.concorrente);
      if (!porConc.has(key))
        porConc.set(key, { concorrente: o.concorrente, handle: null, nota: null,
          temColeta: false, ofertas: 0, comparaveis: 0, abaixo: 0, confianca: { Alta: 0, "Média": 0, Baixa: 0 }, exemplos: [] });
      const e = porConc.get(key);
      e.temColeta = true;
      e.ofertas++;
      if (o.abaixo_do_nosso != null) { e.comparaveis++; if (o.abaixo_do_nosso) e.abaixo++; }
      const nc = o.nivel_confianca || "";
      if (/alta/i.test(nc)) e.confianca.Alta++;
      else if (/m[eé]dia/i.test(nc)) e.confianca["Média"]++;
      else if (/baixa/i.test(nc)) e.confianca.Baixa++;
      if (o.abaixo_do_nosso && e.exemplos.length < 5)
        e.exemplos.push({ produto: o.produto, marca: o.marca || null, promo: o.preco_promo, nosso: o.nosso_preco_medio, confianca: o.nivel_confianca });
    }
    // melhores ofertas: preferir % de desconto real (preço normal x promo); quando a coleta
    // não traz preço normal, usar a comparação contra o NOSSO preço médio.
    const comDescNormal = concRows
      .filter((o) => o.preco_normal > 0 && o.preco_promo > 0 && o.preco_promo < o.preco_normal)
      .map((o) => ({
        produto: o.produto, marca: o.marca || null, concorrente: o.concorrente,
        promo: o.preco_promo, ref: o.preco_normal, base: "normal",
        descPct: Math.round((1 - o.preco_promo / o.preco_normal) * 100),
        confianca: o.nivel_confianca || null,
      }));
    const comDescNosso = concRows
      .filter((o) => o.abaixo_do_nosso && o.nosso_preco_medio > 0 && o.preco_promo > 0)
      .map((o) => ({
        produto: o.produto, marca: o.marca || null, concorrente: o.concorrente,
        promo: o.preco_promo, ref: o.nosso_preco_medio, base: "nosso",
        descPct: Math.round((1 - o.preco_promo / o.nosso_preco_medio) * 100),
        confianca: o.nivel_confianca || null,
      }));
    const comDesc = (comDescNormal.length ? comDescNormal : comDescNosso).sort((a, b) => b.descPct - a.descPct);
    const promos = concRows.map((o) => o.preco_promo).filter((v) => v > 0);

    concorrencia = {
      pending: false,
      totalOfertas: concRows.length,
      comparaveis: concRows.filter((o) => o.abaixo_do_nosso != null).length,
      abaixoDoNosso: concRows.filter((o) => !!o.abaixo_do_nosso).length,
      mediaDescontoPct: comDesc.length ? Math.round(comDesc.reduce((s, o) => s + o.descPct, 0) / comDesc.length) : null,
      melhorPreco: promos.length ? Math.min(...promos) : null,
      melhoresOfertas: comDesc.slice(0, 8),
      nota: "Comparação por casamento aproximado de nome/marca do produto contra o nosso preço médio praticado no mês — leitura direcional, não é preço de tabela.",
      porConcorrente: [...porConc.values()].sort((a, b) => Number(b.temColeta) - Number(a.temColeta) || b.abaixo - a.abaixo || b.ofertas - a.ofertas),
    };
  }

  return {
    status: 200,
    body: {
      loja,
      periodo: periodoSlug(ano, mes),
      meta: {
        periodoLabel: `${MESES_PT[mes]} de ${ano}`,
        endereco: lojaCfg.endereco || null,
        diaParcial: periodo.vendas_ultimo_dia_parcial
          ? { dia: periodo.vendas_ultimo_dia, geradoEm: periodo.vendas_fonte_gerada_em, motivo: periodo.vendas_ultimo_dia_motivo }
          : null,
        totalImpresso: periodo.vendas_total_impresso,
        fonteNota:
          'Faturamento e categorias a partir do relatório "Analítico de Vendas". Categoria de produto é estimada por palavra-chave na descrição — visão direcional, não substitui o cadastro oficial do sistema.',
        atualizadoEm: periodo.atualizado_em,
        aoVivo: ehMesCorrente,
        pollMin: POLL_MIN,
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
    },
  };
}

app.get("/api/analise/:loja/:periodo", (req, res) => {
  try {
    const m = String(req.params.periodo).match(/^(\d{4})-(\d{2})$/);
    if (!m) return res.status(400).json({ erro: "período deve ser AAAA-MM" });
    const r = buildAnalise(req.params.loja, +m[1], +m[2]);
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error("[api/analise]", e);
    res.status(500).json({ erro: e.message });
  }
});

// --- exportação: painel autocontido em 1 arquivo .html (abre sem servidor)

const FONTS_LINK =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">';

function buildStandaloneHtml(analise, loja, periodo) {
  const css = fs.readFileSync(path.join(__dirname, "public", "styles.css"), "utf8");
  const appJs = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
  const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
  const body = indexHtml
    .replace(/^[\s\S]*?<body>/i, "")
    .replace(/<\/body>[\s\S]*$/i, "")
    .replace(/<script src="\/app\.js"><\/script>/i, "");

  // dados assados + stub de fetch: o app.js roda em modo EXPORT e "busca" o que já está aqui.
  const stub = `
  window.__EXPORT__ = true;
  (function () {
    var DB = {
      lojas: ${JSON.stringify([{ nome: loja, endereco: analise.meta.endereco, campanhaNome: null }])},
      periodos: ${JSON.stringify([{ ano: +periodo.slice(0, 4), mes: +periodo.slice(5, 7), periodo: periodo, temVendas: true, atual: false, atualizadoEm: analise.meta.atualizadoEm }])},
      analise: ${JSON.stringify(analise)}
    };
    window.fetch = function (url) {
      url = String(url);
      var data = /\\/api\\/lojas/.test(url) ? DB.lojas
        : /\\/api\\/periodos\\//.test(url) ? DB.periodos
        : /\\/api\\/analise\\//.test(url) ? DB.analise
        : /\\/api\\/ingest-log/.test(url) ? { inbox: "", pollMin: 0, eventos: [] } : undefined;
      if (data === undefined) return Promise.reject(new Error("offline"));
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
    };
    try { localStorage.clear(); } catch (e) {}
  })();`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Analytics — ${loja} — ${analise.meta.periodoLabel}</title>
${FONTS_LINK}
<style>
${css}
</style>
</head>
<body class="export">
${body}
<script>${stub}</script>
<script>${appJs}</script>
</body>
</html>`;
}

app.get("/export/:loja/:periodo", (req, res) => {
  try {
    const m = String(req.params.periodo).match(/^(\d{4})-(\d{2})$/);
    if (!m) return res.status(400).send("período deve ser AAAA-MM");
    const loja = req.params.loja;
    const r = buildAnalise(loja, +m[1], +m[2]);
    if (r.status !== 200) return res.status(r.status).send(r.body.erro || "não encontrado");
    const slug = periodoSlug(+m[1], +m[2]);
    const filename = `analytics-${loja.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slug}.html`;
    res
      .type("html")
      .set("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buildStandaloneHtml(r.body, loja, slug));
  } catch (e) {
    console.error("[export]", e);
    res.status(500).send(e.message);
  }
});

app.get("/export-analise/:loja/:ym", (req, res) => {
  try {
    if (!LOJAS_VALIDAS.includes(req.params.loja)) return res.status(404).send("loja desconhecida");
    if (!/^\d{4}-\d{2}$/.test(req.params.ym)) return res.status(400).send("período deve ser AAAA-MM");
    const doc = analiseStore.read(req.params.loja, req.params.ym);
    if (!doc) return res.status(404).send("sem análise comercial para este período");
    const payload = { loja: req.params.loja, periodo: req.params.ym, meses: [req.params.ym], analise: doc };
    const css = fs.readFileSync(path.join(__dirname, "public", "styles.css"), "utf8");
    const appJs = fs.readFileSync(path.join(__dirname, "public", "app.js"), "utf8");
    const body = fs
      .readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
      .replace(/^[\s\S]*?<body>/i, "")
      .replace(/<\/body>[\s\S]*$/i, "")
      .replace(/<script src="\/app\.js"><\/script>/i, "");
    const stub = `
    window.__EXPORT__ = true; window.__EXPORT_VIEW__ = "analise";
    (function () {
      var LOJAS = ${JSON.stringify([{ nome: req.params.loja }])};
      var RESP = ${JSON.stringify(payload)};
      window.fetch = function (url) {
        url = String(url);
        var data = /\\/api\\/lojas/.test(url) ? LOJAS
          : /\\/api\\/analise-comercial\\//.test(url) ? RESP : undefined;
        if (data === undefined) return Promise.reject(new Error("offline"));
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
      };
      try { localStorage.clear(); } catch (e) {}
    })();`;
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Análise Comercial — ${req.params.loja} — ${req.params.ym}</title>
${FONTS_LINK}<style>${css}</style></head><body class="export">
${body}<script>${stub}</script><script>${appJs}</script></body></html>`;
    res
      .type("html")
      .set("Content-Disposition", `attachment; filename="analise-comercial-${req.params.loja.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${req.params.ym}.html"`)
      .send(html);
  } catch (e) {
    console.error("[export-analise]", e);
    res.status(500).send(e.message);
  }
});

// páginas + assets (atrás da sessão)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// tratador de erro final — multer e afins caem aqui sem passar pelo try/catch das rotas
app.use((err, req, res, next) => {
  if (err && err.name === "MulterError") {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "Arquivo grande demais (máx. 30 MB)." : `Upload inválido: ${err.message}`;
    return res.status(400).json({ erro: msg });
  }
  console.error("[erro]", err);
  res.status(500).json({ erro: (err && err.message) || "erro interno" });
});

// verifica de tempos em tempos se falta a análise comercial do mês corrente/anterior
function verificacaoAnaliseComercial() {
  if (!podeGerar() || process.env.AUTO_ANALISE === "0") return;
  const now = new Date();
  const dPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const meses = [
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    `${dPrev.getFullYear()}-${String(dPrev.getMonth() + 1).padStart(2, "0")}`,
  ];
  const alvo = [];
  for (const loja of LOJAS_VALIDAS) {
    for (const periodo of meses) {
      const [a, m] = periodo.split("-").map(Number);
      if (findPeriodo(loja, a, m)) alvo.push({ loja, periodo });
    }
  }
  if (alvo.length) {
    try {
      require("./motor").maybeAutoAnalise({ tipo: "vendas", meses: alvo });
    } catch (e) {
      console.error("[verificação análise]", e.message);
    }
  }
}

app.listen(PORT, () => {
  console.log(`Analytics em http://localhost:${PORT}`);
  console.log(`  painel:  http://localhost:${PORT}/`);
  console.log(`  inbox:   ${INBOX_DIR}  (jogue aqui o "Analítico de Vendas" .pdf e o Concorrentes_Coleta_*.xlsx)`);
  if (podeGerar()) {
    console.log(`  motor:   análise comercial via ${ANALISE_MODEL}${process.env.AUTO_ANALISE === "0" ? " (auto DESLIGADO)" : " (auto ligado — AUTO_ANALISE=0 desliga)"}`);
  } else {
    console.log(`  motor:   ANTHROPIC_API_KEY não definida — análise comercial só entra por JSON (inbox / POST)`);
  }
  // Fase 3: espelha o calendário recorrente de config/lojas.json na tabela campanhas (idempotente)
  try {
    for (const loja of LOJAS_VALIDAS) {
      const n = dbCat.importarCalendarioCampanhas(loja, (LOJAS_CFG[loja] || {}).campanhas || []);
      if (n) console.log(`  campanhas: ${n} do calendário de ${loja} importadas`);
    }
  } catch (e) {
    console.error("[boot] importar calendário de campanhas:", e.message);
  }
  startWatcher(INBOX_DIR);
  setTimeout(verificacaoAnaliseComercial, 30000);
  setInterval(verificacaoAnaliseComercial, 24 * 3600 * 1000);

  // cópia estática: gera no boot e sempre que o watcher da inbox processar algo novo
  console.log(`  publico: ${PUBLIC_DIR}  (cópia estática que se regenera — copie p/ OneDrive/Drive/GitHub Pages)`);
  setTimeout(() => regenerarPublicoEmBreve(1000), 12000);
  let _ultLog = -1;
  setInterval(() => {
    const n = getLog().length;
    if (_ultLog === -1) { _ultLog = n; return; }
    if (n !== _ultLog) { _ultLog = n; regenerarPublicoEmBreve(2000); }
  }, 20000);
});
