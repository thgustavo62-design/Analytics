// Vercel serverless — o "só mostra" do modelo híbrido.
// O PC (servidor local) calcula tudo e faz UPSERT em analytics_snapshots (Supabase Postgres).
// Aqui a gente só LÊ: mapeia o caminho /api/... para a chave da snapshot e devolve o JSON.
// Nenhuma regra de negócio, nenhum parsing — o Vercel é vitrine.
//
// Env necessária no projeto Vercel:  SUPABASE_DB_URL  (a connection string do Supabase;
// use a porta 6543 "transaction pooler" para serverless).

const { Pool } = require("pg");

let _pool = null;
function db() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10000,
    });
  }
  return _pool;
}

const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const key = (loja, endpoint, periodo) => [loja || "__global__", endpoint, periodo || ""].join("|");

// caminho (array de segmentos depois de /api/) -> chave da snapshot  (espelha supabase-sync.js)
function chaveDe(p) {
  const h = p[0];
  const r = p.slice(1).map(dec);
  if (h === "lojas") return key(null, "lojas", null);
  if (h === "periodos") return key(r[0], "periodos", null);
  if (h === "analise") return key(r[0], "analise", r[1]);
  if (h === "ontologia") return key(r[0], "ontologia", r[1]);
  if (h === "analise-comercial") return key(r[0], "analise-comercial", r[1] || null);
  if (h === "catalogo") return key(r[0], "catalogo", null);
  if (h === "marketing") return key(r[0], "marketing/" + r[r.length - 1], null);
  if (h === "intelligence") return key(r[0], "intelligence/" + r[r.length - 1], null);
  return null;
}

module.exports = async (req, res) => {
  const parts = [].concat(req.query.path || []).filter(Boolean);
  const metodo = (req.method || "GET").toUpperCase();

  res.setHeader("Access-Control-Allow-Origin", "*");
  if (metodo === "OPTIONS") return res.status(204).end();

  if (metodo !== "GET") {
    return res.status(503).json({ erro: "Esta ação só funciona no site ao vivo (o PC). O site hospedado é somente leitura." });
  }
  if (parts[0] === "ingest-log") return res.json({ inbox: "(hospedado no Supabase)", pollMin: 0, eventos: [] });

  const k = chaveDe(parts);
  if (!k) return res.status(404).json({ erro: "rota não mapeada: /" + parts.join("/") });

  try {
    const { rows } = await db().query(
      "select payload, atualizado_em from analytics_snapshots where chave = $1",
      [k]
    );
    if (!rows.length) return res.status(404).json({ erro: "sem dado publicado ainda para " + k });
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=600");
    res.setHeader("X-Snapshot-Atualizado", rows[0].atualizado_em);
    return res.json(rows[0].payload);
  } catch (e) {
    return res.status(500).json({ erro: "falha ao ler o Supabase: " + e.message });
  }
};
