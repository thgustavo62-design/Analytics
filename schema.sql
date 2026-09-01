-- Modelo de dados do Vermelhinha Analytics (seção 4 do spec).
-- Uma loja nunca é somada com a outra: toda agregação passa por periodo_id, que já
-- pertence a uma única loja.

CREATE TABLE IF NOT EXISTS lojas (
  id   INTEGER PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL            -- 'Minas Farma' | 'Farma e Farma'
);

CREATE TABLE IF NOT EXISTS periodos (
  id         INTEGER PRIMARY KEY,
  loja_id    INTEGER NOT NULL REFERENCES lojas(id),
  ano        INTEGER NOT NULL,
  mes        INTEGER NOT NULL,
  criado_em  TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  vendas_ultimo_dia        TEXT,      -- 'AAAA-MM-DD' do último dia com venda no relatório
  vendas_ultimo_dia_parcial INTEGER, -- 1/0: esse dia está truncado
  vendas_ultimo_dia_motivo TEXT,     -- por que foi marcado como parcial
  vendas_total_impresso    REAL,     -- "Total:" lido do rodapé do PDF (auditoria)
  vendas_fonte_gerada_em   TEXT,     -- timestamp do cabeçalho "Pag.: 1/N"
  UNIQUE(loja_id, ano, mes)
);

CREATE TABLE IF NOT EXISTS vendas_transacoes (
  id            INTEGER PRIMARY KEY,
  periodo_id    INTEGER NOT NULL REFERENCES periodos(id),
  data          TEXT NOT NULL,         -- 'AAAA-MM-DD'
  hora          TEXT,
  lancamento    TEXT NOT NULL,         -- Nº Lanc. (chave da venda; várias linhas por lançamento)
  barras        TEXT,
  descricao     TEXT NOT NULL,
  categoria     TEXT NOT NULL,         -- calculada pelo classificador
  preco_unit    REAL,
  quantidade    REAL NOT NULL,
  valor_liquido REAL NOT NULL,
  forma_pagto   TEXT,                  -- 'A VISTA' | 'A PRAZO'
  emp_id        TEXT,                  -- Emp. ID (convênio/empresa)
  cli_id        TEXT                   -- Cli. ID (cliente)
);
CREATE INDEX IF NOT EXISTS ix_vendas_periodo ON vendas_transacoes(periodo_id);
CREATE INDEX IF NOT EXISTS ix_vendas_periodo_data ON vendas_transacoes(periodo_id, data);

CREATE TABLE IF NOT EXISTS instagram_metricas (
  id             INTEGER PRIMARY KEY,
  periodo_id     INTEGER NOT NULL REFERENCES periodos(id),
  metrica        TEXT NOT NULL,        -- 'visualizacoes' | 'alcance' | ...
  rotulo         TEXT NOT NULL,        -- 'Visualizações'
  valor_exibicao TEXT NOT NULL,        -- '414,3 mil'
  delta_pct      REAL,
  observacao     TEXT,
  ordem          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_ig_periodo ON instagram_metricas(periodo_id);

CREATE TABLE IF NOT EXISTS concorrencia_ofertas (
  id               INTEGER PRIMARY KEY,
  periodo_id       INTEGER NOT NULL REFERENCES periodos(id),
  concorrente      TEXT NOT NULL,
  categoria        TEXT,
  produto          TEXT NOT NULL,
  preco_normal     REAL,
  preco_promo      REAL,
  validade         TEXT,
  nivel_confianca  TEXT,               -- 'Alta' | 'Média' | 'Baixa'
  status_validacao TEXT,               -- 'Confirmada' | 'Pendente' | ...
  nosso_preco_medio REAL,              -- preço médio praticado por nós no produto casado (ou NULL)
  abaixo_do_nosso  INTEGER             -- 1/0/NULL
);
CREATE INDEX IF NOT EXISTS ix_conc_periodo ON concorrencia_ofertas(periodo_id);

-- ============================================================================
-- EVOLUÇÃO / FASE 1 — Data Foundation (catálogo por EAN + histórico de estoque/custo/preço)
-- ============================================================================

-- Catálogo GLOBAL de produtos (a mesma EAN é o mesmo produto nas duas lojas).
-- Populado automaticamente a partir dos 'barras' das vendas; enriquecido por planilhas.
-- Campos *_manual têm precedência sobre a classificação automática.
CREATE TABLE IF NOT EXISTS produtos (
  id                    INTEGER PRIMARY KEY,
  ean                   TEXT UNIQUE,           -- pode ser NULL (produto sem código de barras)
  descricao             TEXT NOT NULL,
  descricao_normalizada TEXT NOT NULL,
  marca                 TEXT,
  categoria             TEXT,                  -- classificada automaticamente
  subcategoria          TEXT,
  descricao_manual      TEXT,
  marca_manual          TEXT,
  categoria_manual      TEXT,
  subcategoria_manual   TEXT,
  fonte                 TEXT NOT NULL DEFAULT 'vendas',  -- vendas | catalogo | manual
  ativo                 INTEGER NOT NULL DEFAULT 1,
  primeira_venda        TEXT,
  ultima_venda          TEXT,
  criado_em             TEXT NOT NULL,
  atualizado_em         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_produtos_norm ON produtos(descricao_normalizada);
CREATE INDEX IF NOT EXISTS ix_produtos_cat  ON produtos(categoria);

-- Histórico de estoque por loja/produto/data (nunca sobrescreve; um snapshot por dia).
CREATE TABLE IF NOT EXISTS produto_estoque (
  id              INTEGER PRIMARY KEY,
  loja_id         INTEGER NOT NULL REFERENCES lojas(id),
  produto_id      INTEGER NOT NULL REFERENCES produtos(id),
  quantidade      REAL,
  reservado       REAL,
  disponivel      REAL,
  data_referencia TEXT NOT NULL,               -- 'AAAA-MM-DD'
  fonte           TEXT,
  criado_em       TEXT NOT NULL,
  UNIQUE(loja_id, produto_id, data_referencia)
);
CREATE INDEX IF NOT EXISTS ix_estoque_lp   ON produto_estoque(loja_id, produto_id);
CREATE INDEX IF NOT EXISTS ix_estoque_data ON produto_estoque(loja_id, data_referencia);

-- Histórico de custo por loja/produto (vigência com data_inicio/data_fim; nunca sobrescreve).
CREATE TABLE IF NOT EXISTS produto_custo (
  id          INTEGER PRIMARY KEY,
  loja_id     INTEGER NOT NULL REFERENCES lojas(id),
  produto_id  INTEGER NOT NULL REFERENCES produtos(id),
  custo       REAL NOT NULL,
  data_inicio TEXT NOT NULL,
  data_fim    TEXT,
  fonte       TEXT,
  criado_em   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_custo_lp ON produto_custo(loja_id, produto_id, data_inicio);

-- Histórico de preço por loja/produto (normal | promocional | planejado).
CREATE TABLE IF NOT EXISTS produto_preco (
  id          INTEGER PRIMARY KEY,
  loja_id     INTEGER NOT NULL REFERENCES lojas(id),
  produto_id  INTEGER NOT NULL REFERENCES produtos(id),
  preco       REAL NOT NULL,
  tipo_preco  TEXT NOT NULL DEFAULT 'normal',  -- normal | promocional | planejado
  data_inicio TEXT NOT NULL,
  data_fim    TEXT,
  fonte       TEXT,
  criado_em   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_preco_lp ON produto_preco(loja_id, produto_id, tipo_preco, data_inicio);

CREATE INDEX IF NOT EXISTS ix_vendas_barras ON vendas_transacoes(barras);

-- ---- FASE 3 — Campanha como entidade persistente -------------------------

CREATE TABLE IF NOT EXISTS campanhas (
  id           INTEGER PRIMARY KEY,
  loja_id      INTEGER NOT NULL REFERENCES lojas(id),
  nome         TEXT NOT NULL,
  objetivo     TEXT,                  -- ALCANCE | ENGAJAMENTO | AQUISICAO | CONVERSAO | AUMENTAR_TICKET | DEFENDER_CONCORRENCIA | GIRAR_ESTOQUE | LANCAMENTO | RECUPERAR_CATEGORIA | INSTITUCIONAL
  categoria    TEXT,
  data_inicio  TEXT,
  data_fim     TEXT,
  status       TEXT NOT NULL DEFAULT 'rascunho',  -- rascunho | planejada | ativa | encerrada
  descricao    TEXT,
  investimento REAL,
  origem       TEXT NOT NULL DEFAULT 'manual',    -- manual | calendario | builder
  criado_em    TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_campanhas_loja ON campanhas(loja_id, data_inicio);

CREATE TABLE IF NOT EXISTS campanha_produtos (
  id                INTEGER PRIMARY KEY,
  campanha_id       INTEGER NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
  produto_id        INTEGER NOT NULL REFERENCES produtos(id),
  papel             TEXT,             -- CHAMARIZ | MARGEM | GIRO | HERO | COMPLEMENTAR | DEFESA | LANCAMENTO
  preco_planejado   REAL,
  preco_promocional REAL,
  prioridade        INTEGER,
  UNIQUE(campanha_id, produto_id)
);

CREATE TABLE IF NOT EXISTS campanha_resultados (
  campanha_id   INTEGER PRIMARY KEY REFERENCES campanhas(id) ON DELETE CASCADE,
  metricas_json TEXT,
  resultado     TEXT,                 -- EXCELENTE | BOA | ACEITAVEL | FRACA | DESTRUTIVA | INCONCLUSIVO
  score         REAL,
  analise       TEXT,
  atualizado_em TEXT NOT NULL
);

-- ---- FASE 4 — Cesta (materialização de support/confidence/lift) ---------

CREATE TABLE IF NOT EXISTS cesta_pares (
  id           INTEGER PRIMARY KEY,
  loja_id      INTEGER NOT NULL REFERENCES lojas(id),
  janela_ini   TEXT NOT NULL,
  janela_fim   TEXT NOT NULL,
  produto_a    INTEGER NOT NULL REFERENCES produtos(id),
  produto_b    INTEGER NOT NULL REFERENCES produtos(id),
  cupons_a     INTEGER NOT NULL,
  cupons_b     INTEGER NOT NULL,
  cupons_ab    INTEGER NOT NULL,
  support      REAL NOT NULL,
  confidence   REAL NOT NULL,
  lift         REAL NOT NULL,
  criado_em    TEXT NOT NULL,
  UNIQUE(loja_id, janela_ini, janela_fim, produto_a, produto_b)
);
CREATE INDEX IF NOT EXISTS ix_cesta_loja ON cesta_pares(loja_id, janela_fim);

-- ============================================================================

-- Fase 2: análise comercial mensal (JSON do Motor). Guardado no banco para não se perder
-- se os arquivos forem mexidos; data/analises/*.json é só um espelho/exportação.
CREATE TABLE IF NOT EXISTS analises_comerciais (
  id         INTEGER PRIMARY KEY,
  loja_id    INTEGER NOT NULL REFERENCES lojas(id),
  ano        INTEGER NOT NULL,
  mes        INTEGER NOT NULL,
  gerado_em  TEXT,                  -- meta.gerado_em do JSON
  json       TEXT NOT NULL,         -- o documento inteiro
  criado_em  TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE(loja_id, ano, mes)
);
