// Copia o front (index.html, app.js, styles.css) de public/ para vercel/, para o deploy do
// Vercel usar EXATAMENTE o mesmo app do localhost. Roda antes de cada deploy:
//   node scripts/build-vercel.js
//
// vercel/ é um site estático plano (index.html na raiz) + api/proxy.js como function.
// A única diferença: o index.html copiado carrega /hosted.js quando NÃO está em localhost
// (marca modo somente-leitura + faixa). Localhost segue rodando o app completo.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "public");
const OUT = path.join(ROOT, "vercel");

for (const f of ["app.js", "styles.css"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}

let html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const guard =
  '<script>if(!/^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname))' +
  "document.write('<script src=\"/hosted.js\"><\\/script>');</script>\n";
html = html.replace('<script src="/app.js"></script>', guard + '<script src="/app.js"></script>');
fs.writeFileSync(path.join(OUT, "index.html"), html);

console.log("vercel/ atualizado: index.html, app.js, styles.css (hosted.js e api/proxy.js já versionados)");
console.log("deploy:  cd vercel && vercel deploy --prod");
