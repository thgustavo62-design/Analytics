# Campaign Engine — referência (Fase 3)

`campanhas.js` + tabelas `campanhas` / `campanha_produtos` / `campanha_resultados`. Tudo
determinístico; o simulador nunca promete venda futura.

## Campanha como entidade

O calendário recorrente continua em `config/lojas.json` (`campanhas[{nome, dias, categorias}]`)
— é a fonte de verdade do que se repete toda semana. No boot, `db.importarCalendarioCampanhas`
espelha cada uma na tabela `campanhas` (idempotente, por nome+loja, `origem:"calendario"`), para
que apareçam junto com campanhas manuais/do Builder e possam guardar `campanha_resultados`.

CRUD: `GET/POST/PATCH/DELETE /api/marketing/:loja/campaigns[/:id]`.

## Eficiência (campanhas recorrentes)

`GET /api/marketing/:loja/campaign-efficiency?nome=...` (ou sem `nome` → todas do calendário).

Para a(s) categoria(s) da campanha, compara a receita/unidades **média por dia** nos
dias-de-semana da campanha vs. os demais dias, numa janela de 90d:

- `DEMAND_LIFT_receita` / `DEMAND_LIFT_unidades` — média campanha ÷ média fora.
- `EFFICIENCY_SCORE` — 0–100, ancorado no lift (1.0x→50, 2.0x→100).
- `SELL_THROUGH`, `MARGIN_SACRIFICE`, `STOCK_IMPACT` — `null` sem feed de estoque/custo
  (listados em `dados_ausentes`).
- Veredito: EXCELENTE (≥1.5x) / BOA (≥1.25x) / ACEITAVEL (≥1.08x) / FRACA (≥0.95x) / DESTRUTIVA
  (abaixo) / INCONCLUSIVO (amostra curta). **Nunca DESTRUTIVA sem custo cadastrado** — sem
  margem não há como provar que a campanha destrói rentabilidade, só que vendeu pouco (vira
  FRACA).
- `aviso`: é leitura observacional (correlação dia-da-semana × categoria), não isola preço,
  clima, salário ou concorrência.

## Campaign Builder

`GET /api/marketing/:loja/:periodo/campaign-builder?objetivo=...&categorias=A,B`

Lê o Opportunity Score + classes da Fase 2 e monta um elenco por papel:

| Papel | Critério |
|---|---|
| CHAMARIZ | classe TRAFEGO ou GIRO_URGENTE, ou top percentil de cupons — puxa fluxo |
| HERO | classe HERO ou top percentil de receita — sustenta o faturamento |
| MARGEM | maior `margem_pct` (com custo); sem custo, **proxy declarado** = maior preço praticado, marcado `proxy:true` |
| GIRO | GIRO_URGENTE / estoque parado — campanha para recuperar capital |
| COMPLEMENTAR | parceiro de cesta (Fase 4) de um dos HERO escolhidos — eleva ticket |
| DEFESA | classe DEFESA (categoria sob pressão de concorrência) |

Mais `evitar[]` (a lista do-not-promote, já com substituto) e `briefing` — texto pronto com o
elenco, os motivos e um plano de 7 dias, para colar direto num grupo/planejamento.

## Offer Simulator

`POST /api/marketing/:loja/offer-simulator` — corpo: `{ ean | produto_id, preco_atual,
preco_promocional, custo_atual?, estoque_atual?, duracao_dias? }`. Preço atual e promocional são
obrigatórios no corpo quando não há preço de tabela cadastrado (nunca inventa preço).

Devolve 3 cenários (`CONSERVADOR`/`PROVAVEL`/`AGRESSIVO`), todos ancorados no **lift histórico
real** da categoria (`liftCampanhaPorCategoria`, mesma função da Fase 2) — ou um fallback
declarado de 1.15x quando a categoria não tem histórico de campanha. Cada cenário projeta
unidades, receita, margem bruta (se houver custo) e estoque depois (se houver estoque), com
`risco_ruptura`. Termina sempre com o aviso: **"PROJEÇÃO baseada no comportamento histórico. NÃO
é promessa de venda."**

Ver também [`marketing-opportunity.md`](./marketing-opportunity.md) (Fase 2) e a seção 7 de
[`EVOLUCAO-INTELLIGENCE.md`](./EVOLUCAO-INTELLIGENCE.md).
