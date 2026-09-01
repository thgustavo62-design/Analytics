// Cópia estática que se regenera — TUDO num único HTML (publico/analytics.html).
// As duas lojas, todos os períodos, todas as telas, assados dentro do arquivo. Abre sem
// servidor, com o app shell completo (seletor de loja/período, navegação, gráficos).
//
// Aponte VA_PUBLIC_DIR para uma pasta do OneDrive / Google Drive / GitHub Pages / Netlify e
// o arquivo público se atualiza sozinho, sem expor o servidor.

const fs = require("fs");
const path = require("path");
const { coletarTudo, MK_MARKETING, MK_INTEL } = require("./coletar-tudo");

const FONTS_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">';

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
      if (s[0] === "logout") return {};
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

async function regenerar({ port, cookie, outDir, root = __dirname, arquivo = "analytics.html", B: pronto } = {}) {
  if (_rodando) { _pendente = { port, cookie, outDir, root, arquivo }; return { adiado: true }; }
  _rodando = true;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const B = pronto || (await coletarTudo({ port, cookie })).B;
    const html = montarHtml(root, B);
    const dest = path.join(outDir, arquivo);
    fs.writeFileSync(dest, html);
    // index.html = mesma coisa, para o Vercel/host servir em "/" direto (deploy 100% estático)
    fs.writeFileSync(path.join(outDir, "index.html"), html);
    const comDados = Object.values(B.marketing).filter(Boolean).length;
    return { arquivo: dest, bytes: Buffer.byteLength(html), lojas_com_dados: comDados, geradoEm: B.geradoEm };
  } finally {
    _rodando = false;
    if (_pendente) { const p = _pendente; _pendente = null; setTimeout(() => regenerar(p).catch(() => {}), 500); }
  }
}

module.exports = { regenerar };
