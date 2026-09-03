# Como as partes do Analytics se interligam

Análise do sistema inteiro do ponto de vista de **o que alimenta o quê**. O objetivo é que
nenhuma tela seja um beco sem saída: toda leitura de um lado aparece, com o mesmo número,
onde a decisão é tomada do outro.

## A espinha dorsal

```
PDF de vendas ─┐
planilha estoque/custo/preço ─┤
coleta de concorrentes ─┼──> data/analytics.db ──> marketing-product-analytics.analisarProdutos(loja)
tabela de promoções ─┤            (EAN = chave)        │  giro 7–90d · tendência · cobertura ·
Instagram (form) ─┘                                    │  margem (custo próprio OU proxy da outra loja) ·
                                                       │  Opportunity Score · classe · curva ABC (A/B/C)
                                                       v
        ┌───────────────┬───────────────┬───────────────┬──────────────┬───────────────┐
        v               v               v               v              v               v
   Command Center   Precificação     Concorrentes    Campaign        Playbooks /     Data Quality
   (o que hoje)     (que preço)      (onde reagir)   Builder 2.0     Calendário      (o que está sujo)
```

`analisarProdutos` é o ponto único de verdade por produto. É **memoizado 45 s** — as telas
que rodam na mesma coleta pagam o custo uma vez só. Toda tela abaixo consome esse retorno;
nenhuma recalcula giro/margem/classe por conta própria.

## Ligações que já existem

| De | Para | O que passa |
|---|---|---|
| curva ABC (`marketing/abc.js`) | Command Center, Recomendados, Campaign Builder, Precificação | só produtos **A+B** entram nas listas de ação; a cauda (C) fica fora (aparece só em estoque parado / liquidação) |
| categoria canônica (`categorias.js`) | **todas** as telas | grupo do ERP, coleta do concorrente e classificador por palavra-chave resolvem para as mesmas ~11 categorias — é o que faz "Bebê" do concorrente casar com "Fraldas"+"Leite" nossos |
| custo proxy entre lojas (`db.getCustoProxyOutraLoja`) | margem em toda tela | loja sem custo de um EAN usa o da outra, marcado `custo_proxy`; nunca soma resultados das duas |
| **preço de balcão** (`catalogo.js` + `config/preco-balcao.json`) | margem / Opportunity Score / Precificação / Concorrência — **todas** | o preço usado é o **praticado no balcão** = coluna "preço de promoção" do estoque (tabela − desconto fixo do grupo: Perfumaria −20%, Genérico/Similar −40%). "Preço de venda" é só referência (`tipo_preco='tabela'`). |
| **Precificação** (`marketing/promo-pricing.js`) | **Command Center** | `anunciar[].promo` = preço a colocar, desconto, margem na promo, lucro incremental (via `precoRapido`) |
| **Precificação** | **Concorrentes** | `onde_reagir[].reagir_com` = preço recomendado para reagir + `cobre_o_concorrente` (se dá para chegar no preço deles sem furar o piso de margem) |
| tabela de promoções (`promocoes_planejadas`) | Precificação, Concorrentes (Share of Promotions), Calendário | preço planejado de cada produto → o motor projeta e compara com o recomendado; "esforço sem pressão" no share |
| Medição (Fase C) + Playbooks (Fase D) + fadiga | **Calendário** (ciclo fechado) | cada ocorrência futura ajustada: ruptura → SUSPENDER, fadiga → RENOVAR, esforço sem pressão → REVISAR; `recomendacao_proxima` + link para montar |
| Concorrência (categorias atacadas) | Command Center (alerta), Campaign Builder (papel DEFESA), Calendário (slot DEFESA) | `concorrenciaCategorias` (Set) entra como opts em `analisarProdutos` e vira flag `defensivo` nos produtos |
| Opportunity Score → sub-scores (`marketing/scores.js`) | Command Center | Tráfego / Lucro / Desova / Campanha por produto (Criativo fica `null` até a Fase F) |
| cesta (`basket.js`) | Campaign Builder (combos), Command Center (componente "cesta" do score) | pares support/confidence/lift + retrato de marketing de cada perna |
| detecção (`intelligence/`) | War Room, Decisões recomendadas, Pauta 7 dias, Ontologia | sinais com evidência; `decisao.js` cruza sinais abertos em playbooks |
| **Redes Sociais** (`social-analise.js`; prints lidos por visão) | tela Redes Sociais + **Medição (Fase C)** | métrica orgânica mês a mês + tráfego pago; `trafego_pago.investimento` do mês entra automático em `medirCampanha` quando não se passa `investimento` → ROAS/retorno sobre margem sem digitar. Cruza alcance/interações com o faturamento (co-movimento; nunca atribui venda ao anúncio). |

## O que a aba Precificação entrega agora

1. **Por grupo** — escolho um grupo (Fraldas, Limpeza, Bebê, …) e vejo **todos** os produtos
   dele que valem promoção, cada um com preço normal → preço a colocar, desconto, **margem na
   promo**, lucro incremental e unidades incrementais. O cabeçalho do grupo traz o lucro
   incremental total, a margem média e o desconto médio. Vale para **todos os grupos**.
2. **Ranking geral** — a melhor promoção de cada produto A/B, ordenada por lucro incremental.
3. **Busca por produto** — EAN ou descrição → detalhe completo.
4. **Detalhe** (clique em qualquer linha) — curva lucro×desconto, break-even, desconto máx.
   sem prejuízo, 3 preços para testar (conservador/recomendado/agressivo) e a comparação com
   a promoção já planejada na tabela.

O detalhe de cada produto vem **embutido no snapshot publicado**, então a aba funciona
inteira no site estático (Vercel / GitHub Pages), sem servidor.

### Premissa em vigor
A elasticidade-preço por categoria (`config/elasticidade.json`) é **premissa**, não medição —
não há histórico de promoções rodadas para calibrar. Todo resultado carrega o aviso. Quando
a tabela de promoções tiver janelas passadas, o motor passa a calibrar pelo lift observado.

## Lacunas conhecidas (próximas ligações)

- **Campaign Builder** ainda tem lógica de desconto própria (`marketing/campaign-builder.js`)
  — deveria chamar `promo-pricing` para o preço por perna, para bater com a aba Precificação.
- **Forecast / Meta Engine** não existem — o Calendário e a Medição não têm alvo contra o qual
  comparar o incremental.
- **Creative Score** fica `null` em todo lugar até a Fase F (log de publicações).
- **Momentum por subcategoria** — hoje o momentum é só por categoria canônica.
- Elasticidade a calibrar (acima).
