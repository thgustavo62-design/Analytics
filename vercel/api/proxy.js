// Vercel serverless — vitrine do modelo híbrido.
// O PC calcula tudo e faz UPSERT em analytics_snapshots (Supabase). Aqui a gente só LÊ:
// mapeia o caminho /api/... para a chave da snapshot e devolve o JSON.
//
// Env obrigatória no projeto Vercel: SUPABASE_DB_URL  (connection string do Supabase;
// use a porta 6543 "Transaction pooler" para serverless).
//
// Roteado por vercel.json:  /api/(.*)  ->  /api/proxy?path=$1

let _pool = null;
function getPool() {
  if (_pool) return _pool;
  const { Pool } = require("pg");
  _pool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
  });
  return _pool;
}

const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const key = (loja, endpoint, periodo) => [loja || "__global__", endpoint, periodo || ""].join("|");

// segmentos depois de /api/  ->  chave da snapshot  (espelha supabase-sync.js / coletar-tudo.js)
function chaveDe(p) {
  const h = p[0];
  const r = p.slice(1);
  if (h === "lojas") return key(null, "lojas", null);
  if (h === "periodos") return key(r[0], "periodos", null);
  if (h === "analise") return key(r[0], "analise", r[1]);
  if (h === "ontologia") return key(r[0], "ontologia", r[1]);
  if (h === "analise-comercial") return key(r[0], "analise-comercial", r[1] || null);
  if (h === "catalogo") return key(r[0], "catalogo", null);
  if (h === "concorrencia") return key(r[0], "concorrencia", null);
  if (h === "marketing") return key(r[0], "marketing/" + r[r.length - 1], null);
  if (h === "intelligence") return key(r[0], "intelligence/" + r[r.length - 1], null);
  return null;
}

function segmentos(req) {
  // 1) via rewrite:  ?path=intelligence/Minas%20Farma/war-room
  let raw = (req.query && (req.query.path || req.query.p)) || "";
  if (Array.isArray(raw)) raw = raw.join("/");
  // 2) fallback: tira de req.url
  if (!raw) raw = String(req.url || "").split("?")[0].replace(/^\/?api\/?/, "");
  return String(raw)
    .split("/")
    .map((s) => dec(s.trim()))
    .filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const metodo = (req.method || "GET").toUpperCase();
    if (metodo === "OPTIONS") { res.statusCode = 204; return res.end(); }

    const parts = segmentos(req);

    if (metodo !== "GET") {
      res.statusCode = 503;
      return res.json({ erro: "Ação ao vivo só no site em localhost (o PC). O site hospedado é somente leitura." });
    }
    if (!parts.length) { res.statusCode = 400; return res.json({ erro: "caminho vazio" }); }
    if (parts[0] === "ingest-log") return res.json({ inbox: "(hospedado no Supabase)", pollMin: 0, eventos: [] });

    if (!process.env.SUPABASE_DB_URL) {
      res.statusCode = 500;
      return res.json({ erro: "SUPABASE_DB_URL não configurada. Vercel → Project → Settings → Environment Variables → adicione a connection string do Supabase (porta 6543) e faça Redeploy." });
    }

    const k = chaveDe(parts);
    if (!k) { res.statusCode = 404; return res.json({ erro: "rota não mapeada: /" + parts.join("/") }); }

    const { rows } = await getPool().query(
      "select payload, atualizado_em from analytics_snapshots where chave = $1",
      [k]
    );
    if (!rows.length) { res.statusCode = 404; return res.json({ erro: "sem dado publicado ainda para " + k + " — rode a sincronização no PC (POST /api/publicar)." }); }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=600");
    res.setHeader("X-Snapshot-Atualizado", String(rows[0].atualizado_em));
    return res.json(rows[0].payload);
  } catch (e) {
    res.statusCode = 500;
    try { return res.json({ erro: "proxy falhou: " + (e && e.message || e) }); } catch (_) { return res.end("erro"); }
  }
};
