// Site estático que se regenera — TUDO num único HTML.
//
// A cada ingestão, o servidor bate na própria API local (com cookie de sessão válido) e
// "assa" todas as respostas — as DUAS lojas, todos os períodos, todas as telas (Painel,
// Marketing, Intelligence, Conexões, Análise Comercial, Histórico, Configurações) — dentro
// de um só arquivo: <VA_PUBLIC_DIR>/analytics.html. Ele abre sem servidor, com o app shell
// completo (seletor de loja e período funcionando, navegação por abas, gráficos).
//
// Aponte VA_PUBLIC_DIR para uma pasta do OneDrive / Google Drive / GitHub Pages / Netlify e
// o link público passa a se atualizar sozinho, sem expor o servidor.

const fs = require("fs");
const path = require("path");

const FONTS_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">';

// sufixo da rota -> chave no pacote assado
const MK_MARKETING = {
  "produtos": "produtos", "recommended-products": "recommended", "do-not-promote": "dnp",
  "stagnant-stock": "parado", "baskets": "baskets", "combos": "combos",
  "campaign-efficiency": "eficiencia", "campaign-builder": "builder",
};
const MK_INTEL = {
  "war-room": "warRoom", "signals": "signals", "investigations": "investigations",
  "decisions": "decisions", "patterns": "patterns", "editorial-plan": "editorial",
};

async function coletarLoja(get, nome) {
  const L = encodeURIComponent(nome);
  const periodos = (await get(`/api/periodos/${L}`)) || [];
  const comVendas = Array.isArray(periodos) ? periodos.filter((p) => p.temVendas) : [];
  const analise = {};
  const ontologia = {};
  for (const p of comVendas) {
    analise[`${nome}|${p.periodo}`] = await get(`/api/analise/${L}/${p.periodo}`);
    ontologia[`${nome}|${p.periodo}`] = await get(`/api/ontologia/${L}/${p.periodo}`);
  }
  const ultimo = comVendas.length ? (comVendas.find((p) => p.atual) || comVendas[0]).periodo : null;

  const analiseComercial = {};
  const acLatest = await get(`/api/analise-comercial/${L}`);
  if (acLatest && !acLatest.__erro && !acLatest.erro) {
    analiseComercial[nome] = acLatest;
    for (const ym of acLatest.meses || []) analiseComercial[`${nome}|${ym}`] = await get(`/api/analise-comercial/${L}/${ym}`);
  } else {
    analiseComercial[nome] = acLatest; // guarda o {erro:...} p/ a tela mostrar o estado vazio
  }

  let marketing = null;
  let intelligence = null;
  if (ultimo) {
    marketing = {
      produtos: await get(`/api/marketing/${L}/${ultimo}/produtos?limite=90`),
      recommended: await get(`/api/marketing/${L}/${ultimo}/recommended-products`),
      dnp: await get(`/api/marketing/${L}/${ultimo}/do-not-promote`),
      parado: await get(`/api/marketing/${L}/${ultimo}/stagnant-stock`),
      baskets: await get(`/api/marketing/${L}/${ultimo}/baskets`),
      combos: await get(`/api/marketing/${L}/${ultimo}/combos`),
      eficiencia: await get(`/api/marketing/${L}/campaign-efficiency`),
      builder: await get(`/api/marketing/${L}/${ultimo}/campaign-builder`),
    };
    intelligence = {
      warRoom: await get(`/api/intelligence/${L}/war-room`),
      signals: await get(`/api/intelligence/${L}/signals?limite=120`),
      investigations: await get(`/api/intelligence/${L}/investigations`),
      decisions: await get(`/api/intelligence/${L}/decisions`),
      patterns: await get(`/api/intelligence/${L}/patterns`),
      editorial: await get(`/api/intelligence/${L}/editorial-plan`),
    };
  }

  return {
    periodos: { [nome]: periodos },
    analise, ontologia,
    ontologiaUlt: { [nome]: ultimo ? ontologia[`${nome}|${ultimo}`] : null },
    analiseComercial,
    marketing: { [nome]: marketing },
    intelligence: { [nome]: intelligence },
    catalogo: { [nome]: await get(`/api/catalogo/${L}`) },
  };
}

function stubScript(B) {
  return `
  window.__PUBLICO__ = true;
  (function () {
    var B = ${JSON.stringify(B)};
    function NF(){ return { ok:false, status:404, json:function(){ return Promise.resolve({ erro:"não disponível na cópia estática" }); } }; }
    function OK(d){ return { ok:true, status:200, json:function(){ return Promise.resolve(d); } }; }
    var MKM = ${JSON.stringify(MK_MARKETING)}, MKI = ${JSON.stringify(MK_INTEL)};
    function pick(u) {
      var s = String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0].split("/").filter(Boolean).map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } });
      if (s[0] === "logout") return {};                 // no-op
      if (s[0] !== "api") return undefined;
      if (s[1] === "lojas") return B.lojas;
      if (s[1] === "periodos") return B.periodos[s[2]] || [];
      if (s[1] === "ingest-log") return { inbox: "(cópia estática)", pollMin: 0, eventos: [] };
      if (s[1] === "analise") return B.analise[s[2] + "|" + s[3]];
      if (s[1] === "ontologia") return B.ontologia[s[2] + "|" + s[3]] || B.ontologiaUlt[s[2]];
      if (s[1] === "analise-comercial") return s[3] ? B.analiseComercial[s[2] + "|" + s[3]] : B.analiseComercial[s[2]];
      if (s[1] === "catalogo" && s.length === 3) return B.catalogo[s[2]];
      if (s[1] === "marketing") { var m = B.marketing[s[2]]; return m ? m[MKM[s[s.length - 1]]] : undefined; }
      if (s[1] === "intelligence") { var g = B.intelligence[s[2]]; return g ? g[MKI[s[s.length - 1]]] : undefined; }
      return undefined;
    }
    var OFF = "Ação ao vivo (rodar detecção, simular, perguntar, upload, \\"por quê?\\") só no site em localhost. Esta é a cópia estática gerada " + B.geradoEm + ".";
    window.fetch = function (u, opt) {
      if (opt && opt.method && String(opt.method).toUpperCase() !== "GET" && !/\\/logout$/.test(String(u)))
        return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({ erro: OFF }); } });
      var d = pick(u);
      if (d === undefined || (d && d.__erro)) return Promise.resolve(NF());
      return Promise.resolve(OK(d));
    };
    document.addEventListener("DOMContentLoaded", function () {
      var b = document.createElement("div");
      b.textContent = "📄 Cópia estática · " + new Date(B.geradoEm).toLocaleString("pt-BR") + " · Minas Farma + Farma e Farma · atualiza sozinha a cada arquivo processado no sistema";
      b.style.cssText = "background:#1b1f29;color:#cfd3dc;font:12px/1.5 system-ui,sans-serif;padding:6px 14px;text-align:center";
      document.body.insertBefore(b, document.body.firstChild);
    });
  })();`;
}

function montarHtml(root, B) {
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const body = fs
    .readFileSync(path.join(root, "public", "index.html"), "utf8")
    .replace(/^[\s\S]*?<body>/i, "")
    .replace(/<\/body>[\s\S]*$/i, "")
    .replace(/<script src="\/app\.js"><\/script>/i, "");
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Analytics — Minas Farma &amp; Farma e Farma</title>
${FONTS_LINK}<style>${css}</style></head><body class="publico">
${body}
<script>${stubScript(B)}</script>
<script>${appJs}</script>
</body></html>`;
}

let _rodando = false;
let _pendente = null;

async function regenerar({ port, cookie, outDir, root = __dirname, arquivo = "analytics.html" } = {}) {
  if (_rodando) { _pendente = { port, cookie, outDir, root, arquivo }; return { adiado: true }; }
  _rodando = true;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const H = { headers: cookie ? { Cookie: `va_session=${cookie}` } : {} };
    const get = async (p) => {
      try {
        const r = await fetch(`http://localhost:${port}${p}`, H);
        return r.ok ? await r.json() : { __erro: r.status };
      } catch (e) {
        return { __erro: e.message };
      }
    };

    const lojas = (await get("/api/lojas")) || [];
    const B = {
      geradoEm: new Date().toISOString(),
      lojas,
      periodos: {}, analise: {}, ontologia: {}, ontologiaUlt: {},
      analiseComercial: {}, marketing: {}, intelligence: {}, catalogo: {},
    };
    let comDados = 0;
    for (const l of lojas) {
      const parte = await coletarLoja(get, l.nome);
      Object.assign(B.periodos, parte.periodos);
      Object.assign(B.analise, parte.analise);
      Object.assign(B.ontologia, parte.ontologia);
      Object.assign(B.ontologiaUlt, parte.ontologiaUlt);
      Object.assign(B.analiseComercial, parte.analiseComercial);
      Object.assign(B.marketing, parte.marketing);
      Object.assign(B.intelligence, parte.intelligence);
      Object.assign(B.catalogo, parte.catalogo);
      if (parte.marketing[l.nome]) comDados++;
    }

    const html = montarHtml(root, B);
    const dest = path.join(outDir, arquivo);
    fs.writeFileSync(dest, html);
    return { arquivo: dest, bytes: Buffer.byteLength(html), lojas_com_dados: comDados, geradoEm: B.geradoEm };
  } finally {
    _rodando = false;
    if (_pendente) { const p = _pendente; _pendente = null; setTimeout(() => regenerar(p).catch(() => {}), 500); }
  }
}

module.exports = { regenerar };
