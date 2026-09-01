// Site estático que se regenera. A cada ingestão, o servidor chama regenerar(): ele bate na
// própria API local (com um cookie de sessão válido), assa TODAS as respostas dentro de um
// HTML autocontido por loja (Painel + Marketing + Intelligence) + um index.html, e grava em
// VA_PUBLIC_DIR. Aponte essa pasta para OneDrive / Google Drive / GitHub Pages / Netlify e o
// "site" público passa a se atualizar sozinho, sem servidor exposto.

const fs = require("fs");
const path = require("path");

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
const FONTS_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">';

async function coletar(base, get, nome) {
  const L = encodeURIComponent(nome);
  const periodos = (await get(`/api/periodos/${L}`)) || [];
  const comVendas = periodos.filter((p) => p.temVendas);
  if (!comVendas.length) return null;
  const ym = (comVendas.find((p) => p.atual) || comVendas[0]).periodo;

  const marketing = {};
  for (const [k, p] of [
    ["produtos", `/api/marketing/${L}/${ym}/produtos?limite=150`],
    ["recommended", `/api/marketing/${L}/${ym}/recommended-products`],
    ["dnp", `/api/marketing/${L}/${ym}/do-not-promote`],
    ["parado", `/api/marketing/${L}/${ym}/stagnant-stock`],
    ["baskets", `/api/marketing/${L}/${ym}/baskets`],
    ["combos", `/api/marketing/${L}/${ym}/combos`],
    ["eficiencia", `/api/marketing/${L}/campaign-efficiency`],
    ["builder", `/api/marketing/${L}/${ym}/campaign-builder`],
  ]) marketing[k] = await get(p);

  const intelligence = {};
  for (const [k, p] of [
    ["warRoom", `/api/intelligence/${L}/war-room`],
    ["signals", `/api/intelligence/${L}/signals?limite=200`],
    ["investigations", `/api/intelligence/${L}/investigations`],
    ["decisions", `/api/intelligence/${L}/decisions`],
    ["patterns", `/api/intelligence/${L}/patterns`],
    ["editorial", `/api/intelligence/${L}/editorial-plan`],
  ]) intelligence[k] = await get(p);

  return {
    loja: nome, ym,
    periodos,
    analise: await get(`/api/analise/${L}/${ym}`),
    marketing, intelligence,
    catalogo: await get(`/api/catalogo/${L}`),
  };
}

function stub(nome, ym, pacote, geradoEm) {
  const B = JSON.stringify({ nome, ym, geradoEm, ...pacote });
  return `
  window.__EXPORT__ = true; window.__PUBLICO__ = true;
  (function () {
    var B = ${B};
    var L = encodeURIComponent(B.nome);
    function pick(u) {
      u = String(u).split("?")[0];
      if (/\\/api\\/lojas$/.test(u)) return B.lojas;
      if (/\\/api\\/periodos\\//.test(u)) return B.periodos;
      if (/\\/api\\/ingest-log$/.test(u)) return { inbox: "(cópia estática)", pollMin: 0, eventos: [] };
      if (/\\/api\\/analise\\/[^/]+\\/[0-9-]+$/.test(u)) return B.analise;
      if (/\\/api\\/catalogo\\/[^/]+$/.test(u)) return B.catalogo;
      var mm = u.match(/\\/api\\/marketing\\/[^/]+(?:\\/[0-9-]+)?\\/([a-z-]+)$/);
      if (mm) return ({ "produtos": B.marketing.produtos, "recommended-products": B.marketing.recommended,
        "do-not-promote": B.marketing.dnp, "stagnant-stock": B.marketing.parado, "baskets": B.marketing.baskets,
        "combos": B.marketing.combos, "campaign-efficiency": B.marketing.eficiencia, "campaign-builder": B.marketing.builder })[mm[1]];
      var im = u.match(/\\/api\\/intelligence\\/[^/]+\\/([a-z-]+)$/);
      if (im) return ({ "war-room": B.intelligence.warRoom, "signals": B.intelligence.signals,
        "investigations": B.intelligence.investigations, "decisions": B.intelligence.decisions,
        "patterns": B.intelligence.patterns, "editorial-plan": B.intelligence.editorial })[im[1]];
      return undefined;
    }
    var OFF = "Esta é uma cópia estática (gerada " + B.geradoEm + "). Ações ao vivo (rodar detecção, simular, perguntar, upload) só no site em localhost.";
    window.fetch = function (u, opt) {
      if (opt && opt.method && String(opt.method).toUpperCase() !== "GET")
        return Promise.resolve({ ok: false, status: 503, json: function () { return Promise.resolve({ erro: OFF }); } });
      var d = pick(u);
      if (d === undefined) return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({ erro: "não disponível na cópia estática" }); } });
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(d); } });
    };
    try { localStorage.clear(); } catch (e) {}
    document.addEventListener("DOMContentLoaded", function () {
      var b = document.createElement("div");
      b.textContent = "📄 Cópia estática · " + new Date(B.geradoEm).toLocaleString("pt-BR") + " · atualiza sozinha a cada novo arquivo processado";
      b.style.cssText = "background:#1b1f29;color:#cfd3dc;font:12px/1.4 system-ui;padding:6px 14px;text-align:center";
      document.body.insertBefore(b, document.body.firstChild);
    });
  })();`;
}

function montarHtml({ __dirname: root }, nome, ym, pacote, geradoEm) {
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const body = fs
    .readFileSync(path.join(root, "public", "index.html"), "utf8")
    .replace(/^[\s\S]*?<body>/i, "")
    .replace(/<\/body>[\s\S]*$/i, "")
    .replace(/<script src="\/app\.js"><\/script>/i, "");
  const label = (pacote.analise && pacote.analise.meta && pacote.analise.meta.periodoLabel) || ym;
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Analytics — ${nome} — ${label}</title>
${FONTS_LINK}<style>${css}</style></head><body class="export publico">
${body}
<script>${stub(nome, ym, pacote, geradoEm)}</script>
<script>${appJs}</script>
</body></html>`;
}

function indice(gerados, geradoEm) {
  const linhas = gerados
    .map((g) => `<li><a href="${slug(g.loja)}.html">${g.loja}</a> <span>${g.label} · ${(g.bytes / 1024 / 1024).toFixed(1)} MB</span></li>`)
    .join("\n");
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Analytics</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f5f7;color:#1f2430;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;padding:34px 40px;border-radius:16px;box-shadow:0 10px 40px -12px rgba(0,0,0,.2);width:min(460px,92vw)}
h1{font-size:20px;margin:0 0 2px}.s{color:#8a909c;font-size:13px;margin:0 0 20px}
ul{list-style:none;padding:0;margin:0}li{padding:12px 0;border-bottom:1px solid #ebedf0;display:flex;justify-content:space-between;align-items:baseline}
li:last-child{border:0}a{color:#d81f2a;font-weight:700;text-decoration:none;font-size:17px}a:hover{text-decoration:underline}
li span{color:#8a909c;font-size:12px}.f{margin-top:18px;color:#8a909c;font-size:12px}</style></head>
<body><div class="c"><h1>📊 Analytics</h1><p class="s">Minas Farma · Farma e Farma — Baixo Guandu/ES</p>
<ul>${linhas}</ul>
<p class="f">Cópia estática gerada automaticamente em ${new Date(geradoEm).toLocaleString("pt-BR")}.<br>Cada arquivo novo processado no sistema regenera estas páginas.</p></div></body></html>`;
}

let _rodando = false;
let _pendente = false;

async function regenerar({ port, cookie, outDir, root = __dirname } = {}) {
  if (_rodando) { _pendente = true; return { adiado: true }; }
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
    const geradoEm = new Date().toISOString();
    const lojas = (await get("/api/lojas")) || [];
    const gerados = [];
    for (const l of lojas) {
      const pacote = await coletar(null, get, l.nome);
      if (!pacote) continue;
      pacote.lojas = lojas;
      const html = montarHtml({ __dirname: root }, l.nome, pacote.ym, pacote, geradoEm);
      const file = slug(l.nome) + ".html";
      fs.writeFileSync(path.join(outDir, file), html);
      const label = (pacote.analise && pacote.analise.meta && pacote.analise.meta.periodoLabel) || pacote.ym;
      gerados.push({ loja: l.nome, ym: pacote.ym, label, arquivo: file, bytes: Buffer.byteLength(html) });
    }
    fs.writeFileSync(path.join(outDir, "index.html"), indice(gerados, geradoEm));
    return { outDir, geradoEm, gerados };
  } finally {
    _rodando = false;
    if (_pendente) { _pendente = false; setTimeout(() => regenerar({ port, cookie, outDir, root }).catch(() => {}), 500); }
  }
}

module.exports = { regenerar, slug };
