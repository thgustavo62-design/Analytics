// Cópia estática que se regenera — TUDO num único HTML (publico/analytics.html).
// As duas lojas, todos os períodos, todas as telas, assados dentro do arquivo. Abre sem
// servidor, com o app shell completo (seletor de loja/período, navegação, gráficos).
//
// Aponte VA_PUBLIC_DIR para uma pasta do OneDrive / Google Drive / GitHub Pages / Netlify e
// o arquivo público se atualiza sozinho, sem expor o servidor.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { coletarTudo, MK_MARKETING, MK_INTEL } = require("./coletar-tudo");

const FONTS_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">';

// portão do site estático: hash SHA-256 de "usuario:senha" de cada credencial (config/usuarios.json).
// Não é segurança forte (o HTML é estático) — segura link compartilhado casual.
function credHashes() {
  try {
    const us = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "usuarios.json"), "utf8")).usuarios || {};
    return Object.entries(us).map(([u, p]) => crypto.createHash("sha256").update(`${u}:${p}`).digest("hex"));
  } catch {
    return [];
  }
}
function gateScript() {
  const hashes = credHashes();
  if (!hashes.length) return "";
  // portão do site estático. Lembra o acesso por até TTL_H horas (localStorage) e volta a
  // pedir depois disso — não some "para sempre". "Sair" no app limpa o acesso.
  return `
  (function () {
    var OK = ${JSON.stringify(hashes)};
    var KEY = "analytics_gate_v2", TTL = 12 * 3600 * 1000;
    function lido() {
      try {
        var raw = localStorage.getItem(KEY); if (!raw) return false;
        var p = raw.split("|"); if (OK.indexOf(p[0]) < 0) return false;
        return (Date.now() - (+p[1] || 0)) < TTL;
      } catch (e) { return false; }
    }
    window.__gateLogout__ = function () { try { localStorage.removeItem(KEY); localStorage.removeItem("analytics_gate_v1"); } catch (e) {} location.reload(); };
    if (lido()) return;
    var d = document, ov = d.createElement("div");
    ov.id = "gate";
    ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:#f4f5f7;display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ov.innerHTML = '<form id="gf" style="background:#fff;padding:32px;border-radius:14px;box-shadow:0 10px 40px -12px rgba(0,0,0,.2);width:min(320px,90vw)">' +
      '<div style="font-weight:800;font-size:19px;margin-bottom:2px">Analytics</div>' +
      '<div style="color:#8a909c;font-size:12.5px;margin-bottom:18px">Minas Farma · Farma e Farma</div>' +
      '<input id="gu" placeholder="Usuário" autocomplete="username" style="width:100%;padding:10px 12px;border:1px solid #e0e3e8;border-radius:8px;font-size:15px;box-sizing:border-box;margin-bottom:10px">' +
      '<input id="gp" type="password" placeholder="Senha" autocomplete="current-password" style="width:100%;padding:10px 12px;border:1px solid #e0e3e8;border-radius:8px;font-size:15px;box-sizing:border-box">' +
      '<button style="margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#d81f2a;color:#fff;font-size:15px;font-weight:700;cursor:pointer">Entrar</button>' +
      '<div id="ge" style="color:#d81f2a;font-size:12.5px;margin-top:10px;display:none">Usuário ou senha incorretos.</div></form>';
    d.documentElement.style.overflow = "hidden";
    function mostra() { (d.body || d.documentElement).appendChild(ov); }
    if (d.body) mostra(); else d.addEventListener("DOMContentLoaded", mostra);
    ov.addEventListener("submit", async function (e) {
      e.preventDefault();
      var s = ov.querySelector("#gu").value.trim() + ":" + ov.querySelector("#gp").value;
      var hex = "";
      try {
        var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
        hex = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      } catch (x) {}
      if (hex && OK.indexOf(hex) >= 0) {
        try { localStorage.setItem(KEY, hex + "|" + Date.now()); } catch (x) {}
        d.documentElement.style.overflow = ""; ov.remove();
      } else { ov.querySelector("#ge").style.display = "block"; }
    });
  })();`;
}

function stubScript(B) {
  const SB_URL = process.env.SUPABASE_URL || "";
  const SB_ANON = process.env.SUPABASE_ANON_KEY || "";
  return `
  window.__PUBLICO__ = true;
  (function () {
    var B = ${JSON.stringify(B)};
    var SB_URL = ${JSON.stringify(SB_URL)}, SB_ANON = ${JSON.stringify(SB_ANON)};
    var LIVE = !!(SB_URL && SB_ANON);
    function NF(){ return { ok:false, status:404, json:function(){ return Promise.resolve({ erro:"não disponível" }); } }; }
    function OK(d){ return { ok:true, status:200, json:function(){ return Promise.resolve(d); } }; }
    var MKM = ${JSON.stringify(MK_MARKETING)}, MKI = ${JSON.stringify(MK_INTEL)};
    // segmentos de /api/... -> [head, ...resto]
    function segs(u){ return String(u).replace(/^https?:\\/\\/[^/]+/, "").split("?")[0].split("/").filter(Boolean).map(function(x){ try { return decodeURIComponent(x); } catch(e){ return x; } }); }
    // -> o dado assado (fallback offline)
    function pick(u) {
      var s = segs(u);
      if (s[0] === "logout") return {};
      if (s[0] !== "api") return undefined;
      if (s[1] === "lojas") return B.lojas;
      if (s[1] === "periodos") return B.periodos[s[2]] || [];
      if (s[1] === "ingest-log") return { inbox: "(hospedado)", pollMin: 0, eventos: [] };
      if (s[1] === "analise") return B.analise[s[2] + "|" + s[3]];
      if (s[1] === "ontologia") return B.ontologia[s[2] + "|" + s[3]] || B.ontologiaUlt[s[2]];
      if (s[1] === "analise-comercial") return s[3] ? B.analiseComercial[s[2] + "|" + s[3]] : B.analiseComercial[s[2]];
      if (s[1] === "catalogo" && s.length === 3) return B.catalogo[s[2]];
      if (s[1] === "concorrencia") return (B.concorrencia || {})[s[2]];
      if (s[1] === "data-quality") return (B.dataQuality || {})[s[2]];
      if (s[1] === "marketing") { var m = B.marketing[s[2]]; return m ? m[MKM[s[s.length - 1]]] : undefined; }
      if (s[1] === "intelligence") { var g = B.intelligence[s[2]]; return g ? g[MKI[s[s.length - 1]]] : undefined; }
      return undefined;
    }
    // -> a chave da snapshot no Supabase (espelha supabase-sync.js)
    function chaveDe(u) {
      var s = segs(u), h = s[1], r = s.slice(2);
      if (h === "lojas") return "__global__|lojas|";
      if (h === "periodos") return r[0] + "|periodos|";
      if (h === "analise") return r[0] + "|analise|" + r[1];
      if (h === "ontologia") return r[0] + "|ontologia|" + r[1];
      if (h === "analise-comercial") return r[0] + "|analise-comercial|" + (r[1] || "");
      if (h === "catalogo") return r[0] + "|catalogo|";
      if (h === "concorrencia") return r[0] + "|concorrencia|";
      if (h === "data-quality") return r[0] + "|data-quality|";
      if (h === "marketing") return r[0] + "|marketing/" + r[r.length - 1] + "|";
      if (h === "intelligence") return r[0] + "|intelligence/" + r[r.length - 1] + "|";
      return null;
    }
    var OFF = "Ação ao vivo (rodar detecção, simular, perguntar, upload, \\"por quê?\\") só no site em localhost.";
    var _fetch = window.fetch.bind(window);
    function daNuvem(u) {
      var k = chaveDe(u);
      if (!k) return Promise.reject();
      var url = SB_URL + "/rest/v1/analytics_snapshots?select=payload&chave=eq." + encodeURIComponent(k);
      return _fetch(url, { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function (rows) { return (rows && rows[0]) ? rows[0].payload : Promise.reject(); });
    }
    window.fetch = function (u, opt) {
      var su = String(u);
      if (su.indexOf("/api/") !== 0 && !/\\/logout$/.test(su)) return _fetch(u, opt); // fontes, etc.
      if (opt && opt.method && String(opt.method).toUpperCase() !== "GET" && !/\\/logout$/.test(su))
        return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({ erro: OFF }); } });
      var baked = pick(u);
      var fb = function () { return (baked === undefined || (baked && baked.__erro)) ? NF() : OK(baked); };
      if (!LIVE || /\\/logout$/.test(su) || /ingest-log/.test(su)) return Promise.resolve(fb());
      return daNuvem(u).then(function (p) { return OK(p); }).catch(function () { return fb(); });
    };
    document.addEventListener("DOMContentLoaded", function () {
      var b = document.createElement("div");
      b.textContent = (LIVE ? "🔌 Ao vivo do Supabase" : "📄 Cópia estática") + " · " + new Date(B.geradoEm).toLocaleString("pt-BR") + " · Minas Farma + Farma e Farma";
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
<script>${gateScript()}</script>
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
