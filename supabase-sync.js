// Empurra para o Supabase (Postgres) TODAS as respostas de API já calculadas pelo PC, como
// linhas JSON em analytics_snapshots. O site no Vercel lê essas linhas (via uma function
// serverless que segura a connection string). Nenhuma regra de negócio roda no Supabase.
//
// Opt-in: só age se SUPABASE_DB_URL estiver no ambiente (.env). Sem isso, no-op.

const { coletarTudo, MK_MARKETING, MK_INTEL } = require("./coletar-tudo");

const SEP = "|";
const INV_MK = Object.fromEntries(Object.entries(MK_MARKETING).map(([suf, k]) => [k, suf]));
const INV_IN = Object.fromEntries(Object.entries(MK_INTEL).map(([suf, k]) => [k, suf]));

function ativo() {
  return !!process.env.SUPABASE_DB_URL;
}

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const { Pool } = require("pg");
  _pool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10000,
  });
  return _pool;
}

// transforma o pacote B em linhas [{chave, loja, endpoint, periodo, payload}]
function achatar(B) {
  const rows = [];
  const add = (loja, endpoint, periodo, payload) => {
    if (payload === undefined || payload === null) return;
    if (payload && payload.__erro) return; // não publica erro
    rows.push({
      chave: [loja || "__global__", endpoint, periodo || ""].join(SEP),
      loja: loja || null,
      endpoint,
      periodo: periodo || null,
      payload,
    });
  };

  add(null, "lojas", null, B.lojas);
  for (const [loja, periodos] of Object.entries(B.periodos)) add(loja, "periodos", null, periodos);
  for (const [k, v] of Object.entries(B.analise)) { const [loja, ym] = k.split(SEP); add(loja, "analise", ym, v); }
  for (const [k, v] of Object.entries(B.ontologia)) { const [loja, ym] = k.split(SEP); add(loja, "ontologia", ym, v); }
  for (const [k, v] of Object.entries(B.analiseComercial)) {
    const [loja, ym] = k.split(SEP);
    add(loja, "analise-comercial", ym || null, v);
  }
  for (const [loja, c] of Object.entries(B.catalogo)) add(loja, "catalogo", null, c);
  for (const [loja, mk] of Object.entries(B.marketing)) {
    if (!mk) continue;
    for (const [short, val] of Object.entries(mk)) add(loja, "marketing/" + (INV_MK[short] || short), null, val);
  }
  for (const [loja, it] of Object.entries(B.intelligence)) {
    if (!it) continue;
    for (const [short, val] of Object.entries(it)) add(loja, "intelligence/" + (INV_IN[short] || short), null, val);
  }
  return rows;
}

async function sincronizar({ port, cookie, B: pronto } = {}) {
  if (!ativo()) return { pulado: "SUPABASE_DB_URL não definida" };
  const B = pronto || (await coletarTudo({ port, cookie })).B;
  const rows = achatar(B);
  const cli = await pool().connect();
  try {
    await cli.query("begin");
    // UPSERT em lote: uma query com todos os VALUES (evita ~40 round-trips ao pooler remoto)
    const cols = 5;
    const ph = rows.map((_, i) => `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},now())`).join(",");
    const vals = [];
    for (const r of rows) vals.push(r.chave, r.loja, r.endpoint, r.periodo, JSON.stringify(r.payload));
    if (rows.length) {
      await cli.query(
        `insert into analytics_snapshots (chave, loja, endpoint, periodo, payload, atualizado_em)
         values ${ph}
         on conflict (chave) do update set
           loja = excluded.loja, endpoint = excluded.endpoint, periodo = excluded.periodo,
           payload = excluded.payload, atualizado_em = now()`,
        vals
      );
    }
    // remove chaves que não vieram nesta rodada (loja/período que sumiu)
    await cli.query(`delete from analytics_snapshots where chave <> all($1::text[])`, [rows.map((r) => r.chave)]);
    await cli.query(
      `insert into analytics_publicacao_meta (id, gerado_em, lojas) values (1, now(), $1)
       on conflict (id) do update set gerado_em = now(), lojas = excluded.lojas`,
      [JSON.stringify(B.lojas)]
    );
    await cli.query("commit");
  } catch (e) {
    await cli.query("rollback").catch(() => {});
    throw e;
  } finally {
    cli.release();
  }
  return { linhas: rows.length, geradoEm: B.geradoEm };
}

module.exports = { sincronizar, ativo, achatar, SEP };
