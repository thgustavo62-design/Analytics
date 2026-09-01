# Híbrido: PC alimenta · Supabase guarda · Vercel mostra

O PC (servidor local) continua sendo o cérebro: observa a `inbox/`, processa PDF/planilha,
roda a inteligência. A cada ingestão ele **recalcula todas as respostas de API** e:

1. assa tudo em `publico/analytics.html` (cópia estática offline);
2. faz **UPSERT** de cada pedaço em `analytics_snapshots` no **Supabase** (Postgres).

O site no **Vercel** é só vitrine: uma function serverless (`vercel/api/[...path].js`) lê
`analytics_snapshots` e devolve o JSON; o front (`vercel/public/`) é o mesmo app do
localhost, em modo somente-leitura (`hosted.js`).

```
inbox/  →  server.js  →  SQLite (local)  →  coletar-tudo.js  →  ┬─ publico/analytics.html
                                                                └─ analytics_snapshots (Supabase)  ←  Vercel function  ←  navegador
```

## 1. Uma vez: criar as tabelas no Supabase

Supabase → **SQL Editor** → cole e rode [`sql/supabase.sql`](../sql/supabase.sql). Cria só
`analytics_snapshots` e `analytics_publicacao_meta` (prefixo `analytics_` porque o projeto
já tem tabelas de outro sistema — nada mais é tocado).

## 2. No PC: `.env`

`C:\Sistema Marketing\.env` (já no `.gitignore` — nunca commitar):

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:<senha>@aws-1-us-west-2.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://<ref>.supabase.co
```

Porta **5432** (session pooler) para o PC. `server.js` lê o `.env` sozinho no boot; com
`SUPABASE_DB_URL` presente, todo ciclo de ingestão passa a empurrar pro Supabase.
Forçar agora: `POST /api/publicar` (logado).

## 3. No Vercel: deploy da pasta `vercel/`

O front lá é copiado de `public/` por `node scripts/build-vercel.js` (roda antes do deploy).

**Opção A — CLI:**
```
node scripts/build-vercel.js
cd vercel
vercel link          # associe ao projeto prj_VY6VYAACwVyyBkxcJbuaLwP08QYU
vercel env add SUPABASE_DB_URL production
   # cole a MESMA connection string, mas com porta 6543 (transaction pooler, p/ serverless)
vercel deploy --prod
```

**Opção B — GitHub:** conecte o repo no Vercel, **Root Directory = `vercel`**, e adicione a
env `SUPABASE_DB_URL` (porta 6543) em Project → Settings → Environment Variables. O
`vercel/vercel.json` já configura `outputDirectory: public` e a function.

> Serverless usa **porta 6543** (transaction pooler) — 5432 esgota conexão em function.

## Como o caminho vira chave

`vercel/api/[...path].js` e `supabase-sync.js` calculam a MESMA chave:
`[loja || '__global__', endpoint, periodo || ''].join('|')`. Ex.:
`/api/intelligence/Minas Farma/war-room` → `Minas Farma|intelligence/war-room|`.

## Limites / o que NÃO funciona hospedado

- Ações ao vivo (rodar detecção, simulador de oferta, "Perguntar", "Por quê?", upload) →
  a function responde 503; o front esconde os botões (`body.publico`).
- O site só muda quando o PC sincroniza (após cada arquivo processado). Não há watcher no
  Vercel — a `inbox/` é só no PC.
- Listas grandes (produtos, estoque parado, não anunciar) vêm **limitadas** (top ~80/90) com
  o total à parte — tanto no `analytics.html` quanto no Supabase.

## Segurança

- A `SUPABASE_DB_URL` dá acesso total ao banco. Fica **só** no `.env` do PC e nas env vars
  do Vercel — nunca no front, nunca no git.
- **Troque a senha do Postgres** no painel do Supabase: a atual é fraca e passou por canais
  de texto. Depois é só atualizar o `.env` e a env do Vercel.
- `analytics_snapshots` tem RLS com leitura pública, mas o front não usa a `anon` key —
  passa pela function, que segura a connection string. Se um dia expuser a `anon` key no
  front, a RLS já cobre (só SELECT nessas duas tabelas).
