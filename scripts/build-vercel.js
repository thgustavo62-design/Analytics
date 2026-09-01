// Copia o front (index.html, app.js, styles.css) de public/ para vercel/public/, para o
// deploy do Vercel usar EXATAMENTE o mesmo app do localhost. Roda antes de cada deploy:
//   node scripts/build-vercel.js
//
// A única diferença: o index.html copiado carrega /hosted.js quando NÃO está em localhost
// (marca modo somente-leitura + faixa). Localhost segue rodando o app completo.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "public");
const OUT = path.join(ROOT, "vercel", "public");

fs.mkdirSync(OUT, { recursive: true });

for (const f of ["app.js", "styles.css"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}

let html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const guard =
  '<script>if(!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname))' +
  "document.write('<script src=\"/hosted.js\"><\\/script>');</script>\n";
html = html.replace('<script src="/app.js"></script>', guard + '<script src="/app.js"></script>');
fs.writeFileSync(path.join(OUT, "index.html"), html);

console.log("vercel/public/ atualizado: index.html, app.js, styles.css, hosted.js");
console.log("deploy:  cd vercel && vercel deploy --prod   (com SUPABASE_DB_URL nas env do projeto)");
