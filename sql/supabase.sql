-- ============================================================================
-- Lado hospedado (Supabase / Postgres) — SÓ LEITURA para o site no Vercel.
--
-- ATENÇÃO: este projeto Supabase JÁ TEM tabelas de outro sistema (clientes, cotacoes,
-- noticias, produtos, transacoes_fin, ...). Por isso tudo aqui leva o prefixo `analytics_`
-- e o script só faz CREATE TABLE IF NOT EXISTS — não mexe em NADA que já existe.
--
-- Modelo: o PC (servidor local) é o cérebro. A cada ingestão ele RECALCULA todas as
-- respostas de API (Painel, Marketing, Intelligence, Conexões, Análise Comercial, …) e faz
-- UPSERT delas aqui como JSON, por chave. O front no Vercel lê essas linhas.
-- Nenhuma regra de negócio roda no Supabase — ele é só o "correio".
-- ============================================================================

create table if not exists analytics_snapshots (
  chave         text primary key,          -- ex.: 'Minas Farma|intelligence/war-room'
  loja          text,                       -- 'Minas Farma' | 'Farma e Farma' | null (global)
  endpoint      text not null,              -- caminho lógico da API (sem /api/)
  periodo       text,                       -- 'AAAA-MM' quando aplicável
  payload       jsonb not null,
  atualizado_em timestamptz not null default now()
);
create index if not exists ix_analytics_snap_loja on analytics_snapshots (loja);
create index if not exists ix_analytics_snap_endpoint on analytics_snapshots (endpoint);

create table if not exists analytics_publicacao_meta (
  id            int primary key default 1,
  gerado_em     timestamptz not null default now(),
  lojas         jsonb,
  constraint analytics_one_row check (id = 1)
);

-- RLS: leitura pública (o front via Vercel function usa a connection string, mas deixamos
-- pronto caso um dia use a anon key direto). Escrita: só service_role / connection string.
alter table analytics_snapshots       enable row level security;
alter table analytics_publicacao_meta enable row level security;

drop policy if exists analytics_snap_read on analytics_snapshots;
create policy analytics_snap_read on analytics_snapshots for select using (true);

drop policy if exists analytics_meta_read on analytics_publicacao_meta;
create policy analytics_meta_read on analytics_publicacao_meta for select using (true);
