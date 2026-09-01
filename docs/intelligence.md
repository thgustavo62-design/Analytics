# Camada de Inteligência (Fases 5–12) — referência

Tudo determinístico. A IA (opcional, opt-in por `ANTHROPIC_API_KEY`) só **narra** o que o
backend já calculou — nunca inventa número, nunca escolhe produto. Config:
`config/intelligence.json`. Módulos: `intelligence/*` + `ask.js` + `editorial.js`.

Roda automaticamente após cada ingestão de vendas (`ingest.js` e `server.js persistirVendas`
chamam `intelligence.rodarDeteccao(loja)`), e sob demanda em `POST /api/intelligence/:loja/detect`.

## IDs human-readable

`SIG-000193` (sinal), `THR-000031` (ameaça), `OPP-…` (oportunidade), `CON-…` (contradição),
`INV-…` (investigação), `DEC-…` (decisão), `PAT-…` (padrão). Derivados do id numérico
(autoincrement) — estáveis. Prefixos em `config/intelligence.json → codigos`.

## Fase 5 — Intelligence Foundation

`intelligence/contexto.js` monta o "pacote" da loja (Fase 2/3/4 + concorrência + Instagram +
histórico de faturamento + momentum por categoria 14d×14d). Se o último dia de venda é
**parcial**, recua 1 dia para não comparar dia truncado com dias cheios.

`intelligence/detectores.js` — cada detector é uma função pura com limiar em config; **sem o
feed necessário ele não dispara** e se reporta em `indisponivel[]`:

| Detector | Dispara quando | Classe |
|---|---|---|
| `COMPETITOR_PRICE_ATTACK` | ≥ N ofertas de concorrente abaixo do nosso preço na categoria | AMEACA |
| `CATEGORY_DECLINE` / `CATEGORY_GROWTH` | receita da categoria nos últimos 14d vs. 14d anteriores cai/sobe além do limiar (exige base mínima nas duas quinzenas) | AMEACA / OPORTUNIDADE |
| `STOCK_RISK` | produto em ruptura (Fase 2) — **só com feed de estoque** | AMEACA |
| `STAGNANT_STOCK` | itens parados (cobertura) ou, sem feed, "sem giro 45d+" | OPORTUNIDADE |
| `CAMPAIGN_UNDERPERFORMANCE` / `OVERPERFORMANCE` | DEMAND_LIFT da campanha do calendário abaixo/acima do corte | AMEACA / OPORTUNIDADE |
| `DEMAND_ANOMALY` | \|tendência 14d×14d\| ≥ limiar e volume 30d relevante | OPORTUNIDADE (subindo) / SINAL |
| `CROSS_SELL_OPPORTUNITY` | par de cesta com lift alto onde uma perna é HERO e a outra não é puxada | OPORTUNIDADE |
| `MARKETING_OPPORTUNITY` | Opportunity Score alto + classe OPORTUNIDADE/HERO + categoria sem campanha fixa | OPORTUNIDADE |
| `CREATIVE_FATIGUE` | ≥ 2 métricas de Instagram caindo além do limiar no período — **só com métricas de IG** | SINAL |
| `CONTRADICTION` | ex.: campanha "voando" numa categoria em queda; produto recomendado e bloqueado ao mesmo tempo | CONTRADICAO |

`intelligence/priorizacao.js` — **Priority Engine**: `prioridade 0..100` = média ponderada de
severidade, confiança, impacto financeiro normalizado, recência (meia-vida configurável) e
acionabilidade (quão "dá pra fazer algo hoje" por tipo).

`intelligence/index.js` — `rodarDeteccao(loja)`: monta contexto → roda detectores → prioriza →
`db.upsertSinal` (dedupe por `dedupe_key`; reabre o que voltou; `resolverSinaisAusentes`
fecha o que sumiu). Grava tudo em `intel_sinais` + `intel_evidencias`; log em `intel_eventos`.

Rotas: `GET /api/intelligence/:loja/signals` (`?status/classe/tipo`), `GET .../signals/:id`,
`PATCH .../signals/:id` (`{status}`), `POST .../detect` (`?dry=1` não persiste),
`GET .../war-room`.

## Fase 6 — Investigation ("Por quê?")

`intelligence/investigar.js` — dado um sinal (ou pergunta livre), levanta uma **biblioteca de
hipóteses** por assunto (categoria / campanha / produto) e confronta cada uma com os
agregados: vira `suportada` / `refutada` / `inconclusiva`, com a evidência (campo, valor,
fonte, período) anexada. Conclusão = hipótese suportada de maior confiança. `investigarEGravar`
persiste em `intel_investigacoes` + `intel_hipoteses`.

Rotas: `POST /api/intelligence/:loja/investigate` (`{pergunta?, sinalId?, gravar?}`),
`GET .../investigations[/:id]`.

## Fase 7 — Ontology 2.0

`intelligence/ontologia2.js` — pega o grafo da tela "Conexões" (`ontologia.js`, intacto),
**persiste** em `ontology_nodes` / `ontology_edges` (com `forca`, `confianca`, `valid_from`) e
enriquece com nós `produto` / `marca` (top 60 por Opportunity), arestas `combina` (cesta) e
`sobre` (sinal aberto → entidade). Idempotente (upsert por chave).

Rotas: `GET /api/intelligence/:loja/ontology`, `POST .../ontology/sync?periodo=AAAA-MM`.

## Fase 8 — War Room

Aba **Intelligence → War Room** (bloco escuro, denso, tokens isolados em `.warroom`):
KPIs do mês, **Prioridade #1**, Threat Map, Opportunity Map, Contradições, Situação por
categoria (momentum 14d + flag de concorrência). Fonte: `intelligence.warRoom(loja)`.

## Fase 9 — Decision Memory

`intel_decisoes` / `intel_acoes` / `intel_resultados`. Uma decisão guarda os sinais que a
motivaram (`sinais_json`), suas ações e, depois, os resultados medidos (antes/depois/veredito).
`GET .../decisions/:id` traz também **"situação semelhante já aconteceu em…"**.

Rotas: `GET/POST /api/intelligence/:loja/decisions`, `GET .../decisions/:id`,
`POST .../decisions/:id/outcomes` (grava resultado **e** dispara o aprendizado de padrão),
`PATCH .../actions/:id`.

## Fase 10 — Pattern Engine

`intelligence/padroes.js` — quando um resultado é registrado, deriva a chave
`"(tipos de sinal que motivaram) => (tipo de decisão)"` e atualiza `intel_padroes`
(`amostra_n`, `sucessos`, `taxa_sucesso`). Só vira "maduro" com amostra ≥
`config.padroes.amostra_minima` (3). `semelhantes()` casa padrões e decisões passadas pelos
tipos de sinal atuais.

Rota: `GET /api/intelligence/:loja/patterns`.

## Fase 11 — Ask Analytics

`ask.js` — `perguntar(loja, {pergunta})`: monta um **pacote de contexto agregado** (nunca a
base bruta) e roteia por palavra-chave ("por que" → investigação; "o que anuncio" →
recomendados; "combo" → cesta; "campanha vale" → eficiência; "estoque parado"; genérico →
War Room). Resposta no **formato analista**: `{conclusao, evidencias[], hipoteses[], confianca,
acao_sugerida, monitorar}`. Se houver `ANTHROPIC_API_KEY` e a config permitir, a IA recebe
**só** o pacote de números e é proibida de inventar qualquer valor; se falhar, cai no
determinístico (`fonte: "deterministico"`).

Rota: `POST /api/intelligence/:loja/ask` (`{pergunta}`).

## Fase 12 — Editorial Intelligence

`editorial.js` — `planoSemanal(loja)`: para os próximos 7 dias, cruza o calendário de campanha
da loja com o Opportunity Score / classes / do-not-promote e escolhe `produtos_por_dia` itens,
com ângulo (derivado da classe) e CTA de template. O **produto e o ângulo vêm do motor**; a IA
(se houver chave) só lapidaria hook/CTA. Cada item carrega a evidência (`opportunity.score`).

Rota: `GET /api/intelligence/:loja/editorial-plan` (`?inicio=AAAA-MM-DD`).

Ver [`EVOLUCAO-INTELLIGENCE.md`](./EVOLUCAO-INTELLIGENCE.md) §7 para o registro completo das fases.
