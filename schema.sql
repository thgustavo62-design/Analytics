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
-- FASES 5–12 — Camada de Inteligência (determinística; a IA só narra o que já foi calculado)
-- ============================================================================

-- Log append-only do que o motor observou (auditoria + histórico de reabertura de sinal).
CREATE TABLE IF NOT EXISTS intel_eventos (
  id         INTEGER PRIMARY KEY,
  loja_id    INTEGER NOT NULL REFERENCES lojas(id),
  tipo       TEXT NOT NULL,          -- DETECCAO_RODOU | SINAL_ABERTO | SINAL_REABERTO | SINAL_RESOLVIDO | DECISAO_REGISTRADA | ...
  ref_tabela TEXT,
  ref_id     INTEGER,
  payload    TEXT,                   -- JSON livre
  criado_em  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_intel_eventos_loja ON intel_eventos(loja_id, criado_em);

-- Sinais / ameaças / oportunidades / contradições — a saída dos detectores.
CREATE TABLE IF NOT EXISTS intel_sinais (
  id            INTEGER PRIMARY KEY,
  loja_id       INTEGER NOT NULL REFERENCES lojas(id),
  classe        TEXT NOT NULL,       -- SINAL | AMEACA | OPORTUNIDADE | CONTRADICAO
  tipo          TEXT NOT NULL,       -- COMPETITOR_PRICE_ATTACK | CATEGORY_DECLINE | STOCK_RISK | ...
  titulo        TEXT NOT NULL,
  resumo        TEXT,
  severidade    REAL NOT NULL DEFAULT 0,   -- 0..1
  confianca     REAL NOT NULL DEFAULT 0,   -- 0..1
  impacto_estimado REAL,              -- R$/mês estimado (pode ser NULL)
  prioridade    REAL NOT NULL DEFAULT 0,   -- 0..100 (Priority Engine)
  entidade_tipo TEXT,                 -- categoria | produto | campanha | concorrente | loja
  entidade_ref  TEXT,
  periodo       TEXT,                 -- 'AAAA-MM' ou faixa
  status        TEXT NOT NULL DEFAULT 'aberto',  -- aberto | observando | resolvido | descartado
  dedupe_key    TEXT NOT NULL,
  primeira_vez  TEXT NOT NULL,
  ultima_vez    TEXT NOT NULL,
  ocorrencias   INTEGER NOT NULL DEFAULT 1,
  resolvido_em  TEXT,
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE(loja_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_intel_sinais_loja ON intel_sinais(loja_id, status, prioridade);

-- Evidência de cada sinal (lineage: campo, valor, fonte, período).
CREATE TABLE IF NOT EXISTS intel_evidencias (
  id         INTEGER PRIMARY KEY,
  sinal_id   INTEGER NOT NULL REFERENCES intel_sinais(id) ON DELETE CASCADE,
  campo      TEXT NOT NULL,
  valor      TEXT,
  fonte      TEXT,                    -- tabela/consulta/módulo de origem
  periodo    TEXT,
  criado_em  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_intel_evid_sinal ON intel_evidencias(sinal_id);

-- Fase 6 — investigações ("Por quê?") + hipóteses.
CREATE TABLE IF NOT EXISTS intel_investigacoes (
  id          INTEGER PRIMARY KEY,
  loja_id     INTEGER NOT NULL REFERENCES lojas(id),
  pergunta    TEXT NOT NULL,
  sinal_id    INTEGER REFERENCES intel_sinais(id),
  status      TEXT NOT NULL DEFAULT 'aberta',  -- aberta | concluida
  conclusao   TEXT,
  confianca   REAL,
  criado_em   TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intel_hipoteses (
  id             INTEGER PRIMARY KEY,
  investigacao_id INTEGER NOT NULL REFERENCES intel_investigacoes(id) ON DELETE CASCADE,
  texto          TEXT NOT NULL,
  veredito       TEXT NOT NULL DEFAULT 'inconclusiva', -- suportada | refutada | inconclusiva
  confianca      REAL NOT NULL DEFAULT 0,
  evidencias_json TEXT,
  criado_em      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_intel_hip_inv ON intel_hipoteses(investigacao_id);

-- Fase 9 — memória de decisão.
CREATE TABLE IF NOT EXISTS intel_decisoes (
  id           INTEGER PRIMARY KEY,
  loja_id      INTEGER NOT NULL REFERENCES lojas(id),
  titulo       TEXT NOT NULL,
  contexto     TEXT,
  tipo         TEXT,                  -- CAMPANHA | PRECO | ESTOQUE | EDITORIAL | OUTRO
  sinais_json  TEXT,                  -- ids de sinais que motivaram
  decidido_por TEXT,
  decidido_em  TEXT NOT NULL,
  criado_em    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intel_acoes (
  id          INTEGER PRIMARY KEY,
  decisao_id  INTEGER NOT NULL REFERENCES intel_decisoes(id) ON DELETE CASCADE,
  texto       TEXT NOT NULL,
  responsavel TEXT,
  prazo       TEXT,
  status      TEXT NOT NULL DEFAULT 'pendente'  -- pendente | feita | cancelada
);
CREATE TABLE IF NOT EXISTS intel_resultados (
  id          INTEGER PRIMARY KEY,
  decisao_id  INTEGER NOT NULL REFERENCES intel_decisoes(id) ON DELETE CASCADE,
  metrica     TEXT NOT NULL,
  antes       REAL,
  depois      REAL,
  unidade     TEXT,
  veredito    TEXT,                   -- POSITIVO | NEUTRO | NEGATIVO | INCONCLUSIVO
  avaliado_em TEXT NOT NULL,
  nota        TEXT
);
CREATE INDEX IF NOT EXISTS ix_intel_acoes_dec ON intel_acoes(decisao_id);
CREATE INDEX IF NOT EXISTS ix_intel_result_dec ON intel_resultados(decisao_id);

-- Fase 10 — padrões aprendidos (o que costuma funcionar).
CREATE TABLE IF NOT EXISTS intel_padroes (
  id             INTEGER PRIMARY KEY,
  loja_id        INTEGER NOT NULL REFERENCES lojas(id),
  chave          TEXT NOT NULL,        -- ex.: "STAGNANT_STOCK+combo" ou "CATEGORY_DECLINE+campanha"
  descricao      TEXT,
  amostra_n      INTEGER NOT NULL DEFAULT 0,
  sucessos       INTEGER NOT NULL DEFAULT 0,
  taxa_sucesso   REAL,
  ultima_ocorrencia TEXT,
  atualizado_em  TEXT NOT NULL,
  UNIQUE(loja_id, chave)
);

-- Fase 7 — ontologia persistida (nós/arestas com força, confiança e temporalidade).
CREATE TABLE IF NOT EXISTS ontology_nodes (
  id         INTEGER PRIMARY KEY,
  loja_id    INTEGER NOT NULL REFERENCES lojas(id),
  chave      TEXT NOT NULL,            -- id lógico do nó ("cat:Limpeza", "prod:7891...")
  tipo       TEXT NOT NULL,            -- loja|categoria|subcategoria|produto|marca|canal|campanha|concorrente|criativo|conteudo|sinal|...
  rotulo     TEXT NOT NULL,
  atributos_json TEXT,
  visto_em   TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE(loja_id, chave)
);
CREATE TABLE IF NOT EXISTS ontology_edges (
  id         INTEGER PRIMARY KEY,
  loja_id    INTEGER NOT NULL REFERENCES lojas(id),
  de_chave   TEXT NOT NULL,
  para_chave TEXT NOT NULL,
  tipo       TEXT NOT NULL,            -- vende|promove|pressiona|afeta|combina|sobre|causa|...
  forca      REAL NOT NULL DEFAULT 0.5,
  confianca  REAL NOT NULL DEFAULT 0.5,
  valid_from TEXT,
  valid_to   TEXT,
  atributos_json TEXT,
  atualizado_em TEXT NOT NULL,
  UNIQUE(loja_id, de_chave, para_chave, tipo)
);
CREATE INDEX IF NOT EXISTS ix_ontology_edges_loja ON ontology_edges(loja_id, de_chave);

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

-- ============================================================================

-- Tabela de PLANEJAMENTO de promoções: os produtos que vão entrar em oferta e a que
-- preço (o "tabelão"/encarte que a loja monta). Lida de um xlsx/csv jogado na inbox.
-- Alimenta o Share of Promotions (Concorrentes), o Calendário e o Campaign Builder.
CREATE TABLE IF NOT EXISTS promocoes_planejadas (
  id            INTEGER PRIMARY KEY,
  loja_id       INTEGER,                 -- NULL = todas as lojas
  produto_id    INTEGER,                 -- resolvido do catálogo; NULL se não casou
  ean           TEXT,
  descricao     TEXT NOT NULL,
  categoria     TEXT,
  preco_normal  REAL,
  preco_promo   REAL,
  desconto_pct  REAL,
  data_inicio   TEXT,                    -- 'AAAA-MM-DD' ou NULL (vigente já / sem data)
  data_fim      TEXT,                    -- 'AAAA-MM-DD' ou NULL (sem prazo)
  campanha      TEXT,
  fonte_arquivo TEXT,
  chave         TEXT UNIQUE,             -- loja|ean-ou-descricao|inicio  (dedupe no re-upload)
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_promo_plan_loja ON promocoes_planejadas(loja_id, data_fim);
