// One-shot: reclassifica o catálogo com o vocabulário canônico + a categoria REAL do ERP
// (grupo das planilhas de estoque que estão na inbox). Idempotente — pode rodar de novo.
//
//   node scripts/recategorizar.js
//
// Não toca em produtos com correção manual (categoria_manual / categoria_fonte='manual').

const fs = require("fs");
const path = require("path");
const db = require("../db");
const { categoriaCanonica } = require("../categorias");
const { ingestPlanilhaProduto, detectarTipoPlanilha } = require("../catalogo");

const INBOX = process.env.VA_INBOX || path.join(__dirname, "..", "inbox");

function histograma(titulo) {
  const rows = db.db.prepare("SELECT COALESCE(categoria_manual, categoria) c, COUNT(*) n FROM produtos GROUP BY 1 ORDER BY n DESC").all();
  console.log(`\n=== ${titulo} (${rows.reduce((s, r) => s + r.n, 0)} produtos, ${rows.length} categorias) ===`);
  for (const r of rows) console.log("  " + String(r.n).padStart(6), r.c || "(sem categoria)");
}

histograma("ANTES");

// 1) canoniza toda categoria não-manual
const upd = db.db.prepare("UPDATE produtos SET categoria = ?, atualizado_em = ? WHERE id = ?");
let canon = 0;
db.db.exec("BEGIN");
for (const p of db.db.prepare("SELECT id, categoria, categoria_fonte, categoria_manual FROM produtos").all()) {
  if (p.categoria_manual || p.categoria_fonte === "manual") continue;
  const nova = categoriaCanonica(p.categoria);
  if (nova && nova !== p.categoria) { upd.run(nova, new Date().toISOString(), p.id); canon++; }
}
db.db.exec("COMMIT");
console.log(`\n${canon} categorias reescritas para o vocabulário canônico.`);

// 2) aplica a categoria REAL do ERP a partir das planilhas de estoque da inbox
let erpTotal = 0;
for (const f of fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : []) {
  if (!/\.xlsx$/i.test(f) || detectarTipoPlanilha(f.toLowerCase()) !== "estoque") continue;
  try {
    const r = ingestPlanilhaProduto(path.join(INBOX, f));
    console.log(`  ${f}: categoria_erp aplicada em ${r.categoria_erp_aplicada || 0} produtos` +
      (r.grupos_erp_nao_mapeados && r.grupos_erp_nao_mapeados.length ? ` · grupos sem regra: ${r.grupos_erp_nao_mapeados.join(", ")}` : ""));
    erpTotal += r.categoria_erp_aplicada || 0;
  } catch (e) {
    console.log(`  ${f}: ERRO — ${e.message}`);
  }
}
console.log(`\n${erpTotal} produtos com categoria do ERP.`);

histograma("DEPOIS");
