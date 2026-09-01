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
| Catálogo (Fase 1) | `catalogo.js` | `produtos` por EAN a partir das vendas; ingestão de planilhas de estoque/custo/preço (`config/catalogo.json`). |
| Marketing (Fase 2) | `marketing-product-analytics.js` | Janelas por produto, tendência, days-of-cover, margem, classes, Opportunity Score, do-not-promote, substituição, estoque parado. |
| Campanhas (Fase 3) | `campanhas.js` + tabelas `campanhas`/`campanha_produtos`/`campanha_resultados` | Eficiência do calendário, Campaign Builder, Offer Simulator. |
| Cesta (Fase 4) | `basket.js` + tabela `cesta_pares` | Support/confidence/lift, centralidade, combos. |
| Inteligência (Fases 5–12) | `intelligence/*` + `ask.js` + `editorial.js` + tabelas `intel_*` / `ontology_*` | Detectores → sinais priorizados (evidência + dedupe), War Room, investigação "Por quê?", memória de decisão, padrões, ontologia persistida, Ask, pauta editorial de 7 dias. Roda na ingestão. Ver [`intelligence.md`](./intelligence.md). |
| Servidor | `server.js` | Auth por senha (`1234`), `buildAnalise()`, exports `.html`, verificação diária. ~75 rotas (inclui `/api/marketing/...` e `/api/intelligence/...`). |

### Frontend (`public/`, vanilla JS + SVG à mão, sem build)
- `app.js` (~1400 linhas): app shell, roteamento por hash, gráficos SVG, grafo de Conexões, telas de Análise Comercial, Marketing e Intelligence.
- Telas: **Painel** (abas), **Marketing** (Produtos/Recomendados/Não anunciar/Estoque parado/Cestas & Combos/Eficiência/Montar campanha/Simulador), **Intelligence** (War Room/Sinais/Investigações/Decisões/Padrões/Pauta 7 dias/Perguntar), **Conexões** (grafo radial), **Análise Comercial**, **Upload**, **Histórico**, **Configurações**.

### Config
`config/lojas.json` (cnpj, `horaFechamento`, `concorrentes[]`, **`campanhas[{nome,dias,categorias}]`**), `config/categorias.json`, `config/insights.json`, `config/catalogo.json`, `config/marketing-stock.json`, `config/opportunity-score.json`, `config/basket-analysis.json`, `config/intelligence.json`.

### Testes: 52 (`node --test`), fixtures = PDFs reais de agosto/2026.

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
| **1 · Data Foundation** ✅ | Tabelas de produto/estoque/custo/preço. `catalogo.js`: popular `produtos` a partir dos `barras` das vendas (EAN → produto, categoria pelo classificador). Ingester configurável para estoque/custo/preço (`config/catalogo.json`). Correção manual prevalece. `GET /api/catalogo`. | `schema.sql`, `db.js`, `ingest.js`, novo `catalogo.js`, `config/catalogo.json`, teste novo. |
| **2 · Marketing Product Intelligence** ✅ | `marketing-product-analytics.js`: unidades/receita 7/14/30/60/90d, venda média diária, tendência, days-of-cover (`config/marketing-stock.json`), margem (se houver custo), classificações (HERO/TRAFEGO/OPORTUNIDADE/GIRO_URGENTE/PROTEGIDO/COMPLEMENTAR/DEFESA), Opportunity Score com **componentes** (`config/opportunity-score.json`), `do-not-promote`, motor de substituição, estoque parado → ações. | novo módulo + `config/*.json` + rotas `/api/marketing/...` + testes. |
| **3 · Campaigns** ✅ | Campanha vira entidade (`campanhas`/`campanha_produtos`/`campanha_resultados`), importa de `config/lojas.json`. Eficiência (EFFICIENCY_SCORE/DEMAND_LIFT, SELL_THROUGH/MARGIN_SACRIFICE/STOCK_IMPACT quando há estoque/custo), **Campaign Builder**, **Simulador de oferta** (cenários conservador/provável/agressivo). | migrations + `campanhas.js` + rotas + tela **Marketing**. |
| **4 · Basket** ✅ | Market Basket por cupom (`data+lancamento`): support/confidence/lift (pares; trios preparados, sem amostra ainda), com mínimos configuráveis (incl. mínimo por produto isolado, contra ruído). Combos inteligentes (cesta + classe/cobertura/margem da Fase 2). | `basket.js` + `config/basket-analysis.json` + materialização + testes. |
| **5 · Intelligence Foundation** ✅ | `intel_eventos`, `intel_sinais`, `intel_evidencias`. Detectores determinísticos (COMPETITOR_PRICE_ATTACK, CATEGORY_DECLINE/GROWTH, STOCK_RISK, STAGNANT_STOCK, CAMPAIGN_OVER/UNDERPERFORMANCE, DEMAND_ANOMALY, CROSS_SELL/MARKETING_OPPORTUNITY, CREATIVE_FATIGUE, CONTRADICTION). Severidade e `confianca` por regra quantitativa. Priority Engine (`prioridade 0..100`). | `intelligence/` (novo dir) + `config/intelligence.json` + rotas `/api/intelligence/...`. |
| **6 · Investigation** ✅ | `intel_investigacoes` + `intel_hipoteses` + biblioteca de hipóteses por assunto + evidence lineage + endpoint "Por quê?". | `intelligence/investigar.js` + rotas + aba **Investigações**. |
| **7 · Ontology 2.0** ✅ | Grafo persistido (`ontology_nodes`/`ontology_edges` com `forca`/`confianca`/`valid_from`). Novos tipos PRODUTO/MARCA + arestas `combina` (cesta) e `sobre` (sinal). | `intelligence/ontologia2.js` (usa `ontologia.js` intacto) + rotas. |
| **8 · War Room** ✅ | Aba **Intelligence → War Room** (bloco escuro, tokens isolados em `.warroom`): KPIs, prioridade #1, Threat/Opportunity Map, contradições, situação por categoria. IDs `SIG-/THR-/OPP-/CON-000000`. | `intelligence.warRoom()` + tela + CSS escuro isolado. |
| **9 · Decision Memory** ✅ | `intel_decisoes`/`intel_acoes`/`intel_resultados` + "situação semelhante já aconteceu em…". | `db.js` + rotas + aba **Decisões**. |
| **10 · Pattern Engine** ✅ | `intel_padroes` (chave "(tipos de sinal) => (tipo de decisão)", amostra mínima 3), aprende quando um resultado é medido. | `intelligence/padroes.js` + testes. |
| **11 · Ask Analytics** ✅ | `POST /api/intelligence/:loja/ask` → contexto agregado (nunca base bruta) → resposta formato analista (conclusão/evidências/hipóteses/confiança/ação/monitorar). Determinístico; IA opcional só narra. | `ask.js` + aba **Perguntar**. |
| **12 · Editorial Intelligence** ✅ | `GET /api/intelligence/:loja/editorial-plan` — **Pauta de 7 dias** (produto e ângulo do motor; CTA de template; IA só lapidaria hook/CTA). | `editorial.js` + aba **Pauta 7 dias**. |

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

### Fases 2, 3 e 4 — Marketing Product Intelligence · Campaigns · Basket ✅ (2026-09-01)

Feitas em lote (decisão do dono: "emenda as fases 2–4 direto e reporta no fim"). A fonte de
estoque/custo/preço definida foi **planilhas na pasta `inbox/`** (`Estoque_/Custo_/Precos_*.xlsx`,
já suportadas desde a Fase 1). Como ainda não chegou nenhuma, as três fases foram construídas e
verificadas **no modo sem esses feeds**: todo número que dependeria deles sai `null` com o campo
listado em `dados_ausentes`/`dados_ausentes_globais` — nunca estimado. Quando as planilhas
chegarem, os mesmos endpoints passam a devolver days-of-cover, margem, ruptura e sell-through
reais sem nenhuma mudança de código.

**Correção que valia para as 3 fases:** o upload manual (`/upload/vendas`, `/upload/analise`,
tela "Upload de dados") nunca chamava `sincronizarProdutosDeVendas` nem materializava a cesta —
só o watcher da `inbox/` fazia isso (bug herdado da Fase 1). `persistirVendas` em `server.js`
agora faz os dois, nos dois caminhos.

**Migrations (idempotentes):** `campanhas`, `campanha_produtos`, `campanha_resultados` (Fase 3);
`cesta_pares` (Fase 4); índice `ix_vendas_barras`.

**Fase 2 — `marketing-product-analytics.js`:**
- Por produto (chave = EAN normalizado, senão descrição): unidades/receita/cupons em janelas
  7/14/30/60/90d (`db.vendasPorProdutoJanela`, agregação SQL por `barras` cruzando `periodos.loja_id`).
- Tendência: venda média diária dos 14d recentes vs. os 14 anteriores (não 30x30 — janela curta
  o bastante para caber dentro de um único mês de upload), rótulo SUBINDO/ESTÁVEL/CAINDO/SEM_BASE,
  percentual sempre limitado a ±300% para não estourar a UI.
- `dias_cobertura = estoque_disponível / venda_média_diária_30d`, limiares por categoria em
  `config/marketing-stock.json` → RUPTURA/ATENCAO/NORMAL/OPORTUNIDADE/PARADO. Sem feed de
  estoque: `null` + `cobertura_rotulo: "SEM_ESTOQUE"`.
- `margem_unitaria`/`margem_pct` só quando há custo cadastrado (§60 do brief) — senão `null`.
- **Marketing Opportunity Score (0–100)**: 7 componentes em `config/opportunity-score.json`
  (demanda, tendência, margem, estoque, campanha histórica, concorrência, cesta), cada um
  calculado em [0,1] com `fonte` (evidência textual) e `contribuicao`; componente sem dado entra
  neutro (0.5) e é listado em `dados_ausentes`; `confianca` = fração do peso total apoiada em
  dado real. "Campanha histórica" usa um **lift real**: receita média da categoria nos dias de
  campanha do calendário vs. os demais dias, 90d (`liftCampanhaPorCategoria`).
- Classes determinísticas: HERO/TRÁFEGO/OPORTUNIDADE/GIRO_URGENTE/PROTEGIDO/COMPLEMENTAR/DEFESA/
  GIRO, por regras de percentil + cobertura + margem + pressão de concorrência.
- `do-not-promote`: ruptura (cobertura < mínimo p/ campanha), margem abaixo do piso, sem giro há
  45d+; cada motivo com evidência (`campo`/`valor`/`fonte`/`periodo`) + substituto sugerido (mesma
  categoria, cobertura ok, margem igual ou melhor, maior opportunity).
- `estoque parado`: com feed de estoque, por cobertura > limiar + capital parado (estoque×custo);
  sem feed, degrada honestamente para "sem giro há 45d+" (`modo: "sem_giro_proxy"`).
- Pseudo-produtos (DIVERSOS, TAXA DE ENTREGA, …) nunca entram nas telas de marketing.

**Fase 3 — `campanhas.js` + tabela `campanhas`:**
- `eficienciaCalendario`: para cada campanha recorrente de `config/lojas.json`, compara receita/
  unidades médias por dia nos dias-de-campanha da categoria vs. os demais dias (90d) →
  `DEMAND_LIFT_receita/unidades`, `EFFICIENCY_SCORE` (ancorado no lift), veredito EXCELENTE/BOA/
  ACEITAVEL/FRACA/DESTRUTIVA — **nunca DESTRUTIVA sem custo cadastrado** (não dá pra provar
  destruição de margem sem margem). `SELL_THROUGH`/`MARGIN_SACRIFICE`/`STOCK_IMPACT` ficam `null`
  sem estoque/custo.
- **Campaign Builder** (`campaignBuilder`): monta elenco por papel (CHAMARIZ/HERO/MARGEM/GIRO/
  COMPLEMENTAR/DEFESA) a partir do Opportunity Score + classes + cesta (COMPLEMENTAR = parceiro
  de cesta de um HERO escolhido); lista EVITAR = do-not-promote; gera briefing em texto pronto
  pra copiar. Sem custo, MARGEM cai para um proxy declarado (`proxy:true`, preço praticado mais
  alto) em vez de ficar vazio.
- **Offer Simulator** (`offerSimulator`): cenários CONSERVADOR/PROVÁVEL/AGRESSIVO ancorados no
  lift histórico real da categoria (ou fallback declarado de 1.15x); projeta unidades/receita/
  margem/estoque-depois por cenário; risco de ruptura só quando há estoque cadastrado; aviso fixo
  de que é projeção, nunca promessa. Exige preço atual e promocional no corpo (não inventa preço
  de tabela quando não existe).
- Calendário de `config/lojas.json` é espelhado (idempotente, por nome+loja) na tabela
  `campanhas` no boot do servidor — a config continua sendo a fonte de verdade do recorrente; a
  tabela existe para campanhas manuais/Builder e resultado persistido (`campanha_resultados`).

**Fase 4 — `basket.js` + tabela `cesta_pares`:**
- Cesta por cupom (`data + lancamento`, não só `lancamento` — evita colisão entre meses).
  `support = cupons(A,B)/total`, `confidence(A→B) = cupons(A,B)/cupons(A)`, `lift = confidence/
  support(B)`. Limites em `config/basket-analysis.json`: amostra mínima total, mínimo de cupons
  por par **e por produto isolado** (evita "lift 250" de dois produtos de nicho vendidos juntos
  por coincidência 6 vezes), suporte/confiança/lift mínimos. Materializa em `cesta_pares`
  (re-roda a cada ingestão de vendas, `ingest.js` e `server.js persistirVendas`).
- `combos()`: pega os pares materializados e anexa o retrato de marketing de cada perna (classe,
  cobertura, margem, opportunity, tendência) vindo da Fase 2; sugere papel âncora/isca; alerta se
  alguma perna está em risco de ruptura.
- `centralidade()`: soma de `(lift-1)` por produto nos pares em que aparece, normalizada 0–1 —
  alimenta o componente "cesta" do Opportunity Score.

**Rotas novas (`server.js`):** `GET /api/marketing/:loja/:periodo/produtos`,
`/recommended-products`, `/do-not-promote`, `/stagnant-stock`, `/products/:ean`, `/baskets`,
`/combos`, `/campaign-builder`; `GET /api/marketing/:loja/campaign-efficiency` (+ `?nome=`);
`POST /api/marketing/:loja/offer-simulator`; CRUD `GET/POST/PATCH/DELETE
/api/marketing/:loja/campaigns[/:id]`.

**Frontend:** nova seção de sidebar **🎯 Marketing** (`renderMarketing` em `app.js`), com abas
Produtos / Recomendados / Não anunciar / Estoque parado / Cestas & Combos / Eficiência / Montar
campanha / Simulador de oferta. Aviso amarelo padronizado quando algum feed falta. Painel e as
telas existentes não foram tocados.

**Testes:** `test/marketing-product.test.js` (7), `test/basket.test.js` (6),
`test/campanhas.test.js` (7) — **40 testes no total, todos passando.** Cobrem: janelas
monotônicas, clamp de tendência, os 7 componentes do score somando ao score final, confiança
menor que 1 sem custo/estoque, classes coerentes com percentil, do-not-promote com evidência,
degradação para "sem giro" sem feed de estoque; support/confidence/lift dentro dos limites
configurados e nunca vazando pseudo-produto; materialização em `cesta_pares`; `DEMAND_LIFT` e
veredito nunca DESTRUTIVA sem custo; elenco do Builder respeitando o filtro de categoria e o
proxy de margem; simulador com 3 cenários crescentes e exigindo preço quando não há tabela;
import idempotente do calendário; CRUD completo de campanha.

**Verificado E2E (HTTP, servidor real):** upload do PDF de agosto pela rota manual → catálogo
populado (2.873 produtos) **e** cesta materializada na mesma chamada; todas as rotas novas
respondendo com dados reais (Opportunity Score, do-not-promote, cesta com 2 pares limpos após o
filtro de ruído, eficiência do calendário com lift real, Campaign Builder com elenco + briefing,
Offer Simulator com 3 cenários, CRUD de campanhas com o calendário já importado).

**Limitações / pendências:** sem feed de estoque/custo/preço, days-of-cover, margem,
sell-through, MARGIN_SACRIFICE/STOCK_IMPACT e risco de ruptura no simulador continuam `null` —
por desenho, não por bug. A cesta de 1 mês fica magra com o limite de amostra pensado para 90d
(vai naturalmente enriquecer conforme mais meses entrarem).

### Fases 5–12 — Camada de Inteligência ✅ (2026-09-01)

Feitas em lote ("faça as outras fases"). Documento dedicado: [`intelligence.md`](./intelligence.md).
Roda automaticamente após cada ingestão de vendas (`ingest.js` e `server.js persistirVendas`
chamam `intelligence.rodarDeteccao(loja)`); manual em `POST /api/intelligence/:loja/detect`.

**Migrations (idempotentes):** `intel_eventos`, `intel_sinais` (+`UNIQUE(loja_id,dedupe_key)`),
`intel_evidencias`, `intel_investigacoes`, `intel_hipoteses`, `intel_decisoes`, `intel_acoes`,
`intel_resultados`, `intel_padroes` (+`UNIQUE(loja_id,chave)`), `ontology_nodes`, `ontology_edges`.

**Módulos novos:** `intelligence/contexto.js` (pacote determinístico da loja — reúne Fase 2/3/4
+ concorrência + Instagram + histórico + momentum de categoria 14d×14d; recua 1 dia se o último
dia de venda é parcial), `intelligence/detectores.js` (11 detectores com limiar em
`config/intelligence.json`; sem o feed necessário, não dispara e reporta em `indisponivel[]`),
`intelligence/priorizacao.js` (Priority Engine 0..100: severidade, confiança, impacto,
recência com meia-vida, acionabilidade), `intelligence/index.js` (`rodarDeteccao` com dedupe/
reabertura/resolução + `warRoom`), `intelligence/investigar.js` (Fase 6 — biblioteca de
hipóteses por assunto, cada uma vira suportada/refutada/inconclusiva com evidência),
`intelligence/ontologia2.js` (Fase 7 — persiste + enriquece o grafo de `ontologia.js`),
`intelligence/padroes.js` (Fase 10 — aprende de decisão+resultado), `ask.js` (Fase 11),
`editorial.js` (Fase 12). `db.js` ganhou ~25 helpers (`upsertSinal`, `resolverSinaisAusentes`,
`codigoIntel`, investigações/decisões/ações/resultados/padrões, `getOntologiaPersistida`).

**IDs human-readable:** `SIG-/THR-/OPP-/CON-/INV-/DEC-/PAT-000000`, derivados do id numérico.

**Rotas novas:** `/api/intelligence/:loja/{war-room, detect, signals[/:id], investigate,
investigations[/:id], decisions[/:id][/outcomes], actions/:id, patterns, ontology[/sync], ask,
editorial-plan}`.

**Frontend:** nova seção de sidebar **🧠 Intelligence** (`renderIntelligence` em `app.js`) com
abas War Room (bloco escuro, tokens isolados em `.warroom`), Sinais, Investigações, Decisões,
Padrões, Pauta 7 dias, Perguntar. "Por quê?" em qualquer sinal abre a investigação inline.
Nenhuma tela existente foi alterada.

**Testes:** `test/intelligence.test.js` (12) — Priority Engine monotônico; dedupe (2ª rodada 0
novos); todo sinal com evidência (campo+fonte); sem feed de custo/estoque não inventa sinal;
sinal que some é resolvido; War Room; investigação com veredito+evidência e persistência;
roteamento de pergunta livre; decisão→resultado→padrão + semelhantes; ontologia 2.0 persiste e
é idempotente; Ask no formato analista sem inventar; Editorial de 7 dias com evidência.
**52 testes no total, todos passando.**

**Verificado E2E (HTTP):** upload do PDF de agosto → detecção roda na ingestão (22 sinais);
War Room, signals, editorial-plan e ask respondendo com dados reais; nav com o item Intelligence.

**Limitações:** sinais que dependem de estoque/custo (STOCK_RISK real, impacto de margem),
Instagram (CREATIVE_FATIGUE) e coleta de concorrência (COMPETITOR_PRICE_ATTACK) só disparam
quando esses feeds existem — reportados em `indisponivel[]`, nunca forjados. A narração por IA
no Ask é opt-in (`ANTHROPIC_API_KEY`); sem chave, resposta 100% determinística. O "é queda da
loja inteira?" na investigação só conclui com 2+ meses de histórico.
