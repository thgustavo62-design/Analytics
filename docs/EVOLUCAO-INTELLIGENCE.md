# Evolução → Marketing Intelligence & Decision Engine

Documento vivo. Mapa da arquitetura atual, análise de lacunas, riscos, migrations e o
plano de fases. Atualizado a cada fase concluída.

---

## 1. Arquitetura atual (o que já existe)

### Backend (Node/Express, `node:sqlite`, sem framework)

| Camada | Arquivos | Papel |
|---|---|---|
| Ingestão | `watcher.js` (chokidar em `inbox/`) → `ingest.js` | PDF de vendas (roteia a loja pelo **CNPJ** do cabeçalho, split por mês), xlsx `Concorrentes_Coleta_*`, `*.json` (Análise Comercial / Instagram). |
| Parsers | `parsers/vendas.js`, `parsers/concorrentes.js`, `parsers/instagram.js`, `match.js` | `vendas.js` já captura `barras` (EAN), `emp_id`, `cli_id`; valida `Σ == "Total:"`. `match.js` = Jaccard de tokens + marca como filtro duro. |
| Banco | `db.js` + `schema.sql` | Tabelas: `lojas`, `periodos`, `vendas_transacoes`, `instagram_metricas`, `concorrencia_ofertas`, `analises_comerciais`. Migrations leves via `ALTER … ADD COLUMN` em try/catch. **Todo acesso por `periodo_id` (uma loja só).** |
| Camada determinística | `aggregate.js` (KPIs, série diária, dia da semana, categorias, top 15), `analytics-deep.js` (`analiseProfunda`: ticket médio/mediano, baseline semanal c/ desvio, Pareto, incrementalidade intradiária por campanha, canais convênio/delivery/balcão, concentração cliente/convênio, operadores, resumo de concorrentes), `classify.js` (categoria por palavra-chave, `config/categorias.json`), `insights.js` (4 regras → cards). |
| Camada de inteligência (LLM) | `motor.js` + `prompts/motor-analise-comercial.md` + `validate-analise.js` | `analytics-deep.js` agrega → `motor.js` chama a API da Anthropic passando **só os agregados** → JSON validado (`analises_comerciais`). Opt-in por `ANTHROPIC_API_KEY`. |
| Grafo | `ontologia.js` + `GET /api/ontologia/:loja/:periodo` | Nós: loja, categoria, canal, campanha, concorrente, sinal, + achados da Análise Comercial. Arestas com significado (`promove`, `pressiona`, `afeta`, …) + cruzamentos ("Campanha sob pressão em X"). |
| Servidor | `server.js` | Auth por senha (`1234`), `buildAnalise()`, exports `.html`, verificação diária. ~20 rotas. |

### Frontend (`public/`, vanilla JS + SVG à mão, sem build)
- `app.js` (~1000 linhas): app shell, roteamento por hash, gráficos SVG, grafo de Conexões, tela de Análise Comercial.
- Telas: **Painel** (abas), **Conexões** (grafo radial), **Análise Comercial**, **Upload**, **Histórico**, **Configurações**.

### Config
`config/lojas.json` (cnpj, `horaFechamento`, `concorrentes[]`, **`campanhas[{nome,dias,categorias}]`**), `config/categorias.json`, `config/insights.json`.

### Testes: 16 (`node --test`), fixtures = PDFs reais de agosto/2026.

---

## 2. Aderência ao que a evolução pede

O sistema **já segue** os princípios centrais do brief:
- ✅ separação camada determinística ↔ camada de inteligência (a IA nunca faz conta);
- ✅ isolamento por loja/período;
- ✅ toda conclusão da IA sai de agregados calculados;
- ✅ ontologia com relações semânticas (versão 1);
- ✅ Análise Comercial já produz diagnóstico + evidências + hipóteses (`correcoes`) + ações;
- ✅ migrations idempotentes, dados preservados, testes.

O que a evolução **acrescenta** e ainda não existe: catálogo de produto por **EAN**,
histórico de **estoque / custo / preço**, métricas derivadas de produto (days-of-cover,
margem, opportunity score), classificações de produto (HERO/GIRO/PROTEGIDO…), motor de
substituição, campanha como **entidade persistente** + sell-through + eficiência, análise
de cesta (support/confidence/lift), e toda a camada de **Intelligence** (signals, threats,
opportunities, hypotheses, investigations, patterns, decisions, actions, outcomes, events)
com War Room, "Por quê?" e evidence lineage.

---

## 3. Dependência crítica (bloqueio de dados)

> **A maior parte das Fases 2–4 e vários sinais das Fases 5–12 precisam de dados que o
> sistema não recebe hoje: EAN-catálogo, ESTOQUE, CUSTO e PREÇO por loja.**

O que temos: `barras` (EAN) e preço unitário praticado, dentro de `vendas_transacoes`.
O que falta: um feed recorrente de estoque, custo e preço de tabela.

Sem esse feed, o sistema calcula tudo que dá com vendas + concorrência (tendência, giro
por unidades vendidas, Pareto, cesta, sinais de comunicação/concorrência, padrões) e
marca **`dados_ausentes`** para days-of-cover, margem, do-not-promote por ruptura, simulador
de oferta e previsão de estoque pós-campanha — nunca inventa número (§60 do brief).

**Fontes possíveis** (a decidir com o dono):
1. Planilha recorrente (`Estoque_LOJA_AAAA-MM-DD.xlsx`, idem custo/preço) jogada em `inbox/`.
2. Export do ERP Sysemp para `inbox/` (Tarefa Agendada do Windows).
3. Leitura direta do PostgreSQL do ERP (`localhost:5432`, banco `sysemp`) — precisa da senha.

A Fase 1 já cria as tabelas e um ingester **configurável por coluna**, para plugar qualquer
uma dessas fontes sem mexer no código.

---

## 4. Riscos

| Risco | Mitigação |
|---|---|
| Reescrever demais e quebrar o que funciona | Só adição. `schema.sql` roda `CREATE TABLE IF NOT EXISTS` no boot; colunas novas via `ALTER` em try/catch. Nada removido. |
| Análises pesadas (cesta, scores por produto) explodirem | Limites configuráveis (`config/basket-analysis.json`), agregação SQL + índices, materialização/cache com invalidação por evento (Fase 5+). |
| IA "preenchendo" lacunas | `confidence` e todos os números vêm do backend; `dados_ausentes`/`freshness` propagados; prompt reforçado. |
| EAN ausente/sujo em parte das linhas | `produtos` aceita `ean` nulo com `fonte='descricao'` + `match.js` como fallback, sempre com `match_confidence` explícito. |
| Frontend crescer e ficar pesado | Sem framework. Intelligence é camada separada (novo item de sidebar), Painel continua leve. Física do grafo = simples, opcional, degradável. |
| Mistura de lojas em benchmark | Benchmark usa **resultados agregados** por loja, nunca junta `vendas_transacoes`. |

---

## 5. Migrations (planejadas, todas idempotentes)

- **Fase 1:** novas tabelas `produtos`, `produto_estoque`, `produto_custo`, `produto_preco` + índices (`ean`, `produto_id`, `loja_id`, `data_referencia`).
- **Fase 3:** `campanhas`, `campanha_produtos`, `campanha_resultados` + índices. `config/lojas.json → campanhas[]` continua válido e é **importado** para a tabela na primeira execução.
- **Fase 4:** `cesta_pares` (materialização de support/confidence/lift).
- **Fase 5:** `intelligence_events`, `intelligence_signals`, `intelligence_evidence`.
- **Fase 6:** `intelligence_investigations`, `intelligence_hypotheses`.
- **Fase 7:** `ontology_nodes`, `ontology_edges` (persistência do grafo com `strength`/`confidence`/`valid_from`/`valid_to`).
- **Fase 9:** `intelligence_decisions`, `intelligence_actions`, `intelligence_outcomes`.
- **Fase 10:** `intelligence_patterns`.

---

## 6. Plano de fases (mapeado no código)

| Fase | Entrega | Toca |
|---|---|---|
| **1 · Data Foundation** *(em andamento)* | Tabelas de produto/estoque/custo/preço. `catalogo.js`: popular `produtos` a partir dos `barras` das vendas (EAN → produto, categoria pelo classificador). Ingester configurável para estoque/custo/preço (`config/catalogo.json`). Correção manual prevalece. `GET /api/catalogo`. | `schema.sql`, `db.js`, `ingest.js`, novo `catalogo.js`, `config/catalogo.json`, teste novo. |
| **2 · Marketing Product Intelligence** | `marketing-product-analytics.js`: unidades/receita 7/14/30/60/90d, venda média diária, tendência, days-of-cover (`config/marketing-stock.json`), margem (se houver custo), classificações (HERO/TRAFEGO/OPORTUNIDADE/GIRO_URGENTE/PROTEGIDO/COMPLEMENTAR/DEFESA), Opportunity Score com **componentes** (`config/opportunity-score.json`), `do-not-promote`, motor de substituição, estoque parado → ações. | novo módulo + `config/*.json` + rotas `/api/marketing/...` + testes. |
| **3 · Campaigns** | Campanha vira entidade (`campanhas`/`campanha_produtos`/`campanha_resultados`), importa de `config/lojas.json`. Sell-through, eficiência (EFFICIENCY/DEMAND_LIFT/SELL_THROUGH/MARGIN_SACRIFICE/STOCK_IMPACT), **Campaign Builder**, **Simulador de oferta** (cenários conservador/provável/agressivo), previsão de estoque pós-campanha (faixas). | migrations + módulos + telas em **MARKETING**. |
| **4 · Basket** | Market Basket por `lancamento`: support/confidence/lift (pares, trios se viável), com mínimos configuráveis. Combos inteligentes (cesta + estoque + margem + campanha). | `basket.js` + `config/basket-analysis.json` + materialização + testes. |
| **5 · Intelligence Foundation** | `intelligence_events`, `intelligence_signals`, `intelligence_evidence`. Detectores determinísticos (CREATIVE_FATIGUE, COMPETITOR_PRICE_ATTACK, CATEGORY_DECLINE/GROWTH, STOCK_RISK, STAGNANT_STOCK, CAMPAIGN_OVER/UNDERPERFORMANCE, DEMAND_ANOMALY, MARKETING/CROSS_SELL_OPPORTUNITY, CONTRADICTION). Severidade e `confidence` por regra quantitativa. Priority Engine. | `intelligence/` (novo dir) + `config/intelligence.json` + rotas `/api/intelligence/...`. |
| **6 · Investigation** | `investigations` + `hypotheses` + contradiction engine + evidence lineage + endpoint "Por quê?" (árvore navegável). | módulos + rotas + tela **Investigations**. |
| **7 · Ontology 2.0** | Persistir o grafo (nós/arestas com `strength`/`confidence`/temporalidade). Novos tipos (PRODUTO, MARCA, SUBCATEGORIA, CRIATIVO, CONTEUDO, INSTAGRAM_POST, WHATSAPP, …). Grafo com zoom/pan/busca/foco/profundidade, física simples opcional. | evolui `ontologia.js` + `app.js` (grafo). |
| **8 · War Room** | Tela **INTELLIGENCE → War Room** (fundo escuro, denso, sóbrio): status, prioridade #1, Threat Map, Opportunity Map, situação da categoria. IDs human-readable (`SIG-000193`, `THR-000031`, …). | nova tela + design tokens escuros isolados. |
| **9 · Decision Memory** | `decisions`/`actions`/`outcomes` + timeline + "situação semelhante aconteceu em…". | migrations + módulos + tela **Decisions**. |
| **10 · Pattern Engine** | `intelligence_patterns` (amostra mínima), aprendizado por outcome. | `patterns.js` + testes. |
| **11 · Ask Analytics** | Interface de pergunta estruturada → contexto agregado (nunca base bruta) → resposta no formato analista (conclusão/evidências/hipóteses/confiança/ação/monitorar). | rota + tela + prompt. |
| **12 · Editorial Intelligence** | Campanha recomendada, **Pauta de 7 dias** (produto vem do motor determinístico; IA só ajuda hook/CTA), briefing. | `editorial.js` + tela. |

Config nova (§77): `config/opportunity-score.json`, `config/threat-score.json`,
`config/marketing-stock.json`, `config/basket-analysis.json`, `config/intelligence.json`.
Docs nova (§76): `docs/intelligence.md`, `docs/marketing-opportunity.md`,
`docs/ontology-v2.md`, `docs/campaign-engine.md`, `docs/decision-memory.md`.

---

## 7. Registro de fases concluídas

### Fase 1 — Data Foundation ✅ (2026-09-01)

**Migrations (idempotentes, `CREATE TABLE IF NOT EXISTS` no boot):**
`produtos` (catálogo GLOBAL por EAN; campos `*_manual` têm precedência),
`produto_estoque` (snapshot por loja/produto/data, `UNIQUE(loja_id,produto_id,data_referencia)`),
`produto_custo` e `produto_preco` (historizados: `data_inicio`/`data_fim`, nunca sobrescreve;
preço tem `tipo_preco` = normal|promocional|planejado). Índices em `ean`, `descricao_normalizada`,
`categoria`, `(loja_id,produto_id)`, datas.

**Arquivos:**
- `catalogo.js` (novo) — `sincronizarProdutosDeVendas(periodoId)` (popula/atualiza `produtos`
  a partir dos `barras` das vendas; EAN é a chave, senão descrição normalizada; categoria pelo
  classificador; numa transação) e `ingestPlanilhaProduto(filePath)` (lê xlsx de estoque/custo/
  preço com mapeamento de coluna por `config/catalogo.json`; resolve o produto por EAN, senão
  casa por nome com confiança 0.6; loja pelo nome do arquivo ou coluna `loja`).
- `config/catalogo.json` (novo) — `arquivo_contem` por tipo, sinônimos de coluna, tamanhos de EAN.
- `db.js` — helpers: `upsertProduto` (nunca rebaixa fonte manual>catalogo>vendas), `setProdutoOverride`,
  `produtoEfetivo` (override manual vence), `listProdutos`, `contagemCatalogo`, `inserirEstoque`,
  `inserirCusto`/`inserirPreco` (fecham a vigência anterior), `getEstoqueEm`/`getCustoEm`/`getPrecoEm`
  (consulta por data), `freshnessCatalogo`.
- `ingest.js` — após `replaceVendas` de cada mês chama `sincronizarProdutosDeVendas`; o dispatcher
  `.xlsx` roteia `Estoque_/Custo_/Precos_*.xlsx` para `ingestPlanilhaProduto`.
- `server.js` — `GET /api/catalogo/:loja` (contagem + freshness + `faltando[]`),
  `GET /api/catalogo/:loja/produtos` (filtros `categoria`, `sem_ean`, `q`),
  `POST /api/catalogo/produtos/:id` (correção manual).
- `public/app.js` — card "Catálogo (EAN)" em **Configurações**: nº de produtos, com EAN, sem
  categoria, com override; tabela de freshness de estoque/custo/preço; aviso quando falta feed.

**Testes:** `test/catalogo.test.js` (4) — `normalizarEan`; `sincronizarProdutosDeVendas` popula
o catálogo (2.873 produtos do PDF real, todos com EAN e categoria; idempotente); custo
historizado (fecha vigência, consulta por data); preço normal+promocional; correção manual
prevalece. **20 testes no total, todos passando.**

**Verificado E2E:** ingestão do PDF de agosto → 2.873 produtos criados (100% com EAN);
`GET /api/catalogo` reporta `faltando: ["estoque","custo","preço"]` — **nenhum número
inventado**.

**Limitações / pendências desta fase:**
- Não há feed de estoque/custo/preço ainda — a Fase 2 (days-of-cover, margem, opportunity
  score, do-not-promote, simulador) fica bloqueada até definir a fonte (ver §3).
- Marca (`produtos.marca`) fica `null` — não extraímos marca da descrição ainda; virá do feed
  de catálogo ou de uma regra na Fase 2.
- Produtos sem EAN (ex.: "DIVERSOS", "TAXA DE ENTREGA") entram com `ean=NULL` e chave por
  descrição normalizada — comportamento esperado.
