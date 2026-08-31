// Classificador de categoria por palavra-chave. Lê as regras de config/categorias.json
// (recarregado a cada chamada de loadRegras para permitir edição sem reiniciar o servidor).

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config", "categorias.json");

let cache = null;
let cacheMtime = 0;

function loadRegras() {
  const stat = fs.statSync(CONFIG_PATH);
  if (!cache || stat.mtimeMs !== cacheMtime) {
    cache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cacheMtime = stat.mtimeMs;
  }
  return cache;
}

function classificar(descricao) {
  const cfg = loadRegras();
  const d = String(descricao || "").toUpperCase().trim();
  for (const regra of cfg.regras) {
    if (regra.exceto && regra.exceto.some((t) => d.includes(String(t).toUpperCase()))) continue;
    if (regra.igual && regra.igual.some((t) => d === String(t).toUpperCase())) return regra.categoria;
    if (regra.contem && regra.contem.some((t) => d.includes(String(t).toUpperCase()))) return regra.categoria;
  }
  return cfg.fallback;
}

module.exports = { classificar, loadRegras };
