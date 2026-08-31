# Vermelhinha Analytics

Site autoalimentável de resultados para **Minas Farma** e **Farma e Farma** ("A Vermelhinha"),
Baixo Guandu/ES. Você sobe os documentos brutos do mês — relatório de vendas (PDF),
métricas do Instagram e planilha de concorrentes — e o site gera o painel visual
(vendas + redes sociais + concorrência), com histórico por loja/mês.

Projeto **independente** do `app_minasfarma/`. Não lê nem escreve nada lá dentro.

## Stack

- **Node.js** (>= 22; testado no 24) + **Express**. Sem Python.
- **SQLite** via `node:sqlite` (módulo nativo — sem build nativo, sem `better-sqlite3`).
- **PDF:** `pdfjs-dist` (JS puro, roda em qualquer host).
- **Planilhas:** `xlsx` (SheetJS).
- Frontend: HTML/CSS/JS puro, reaproveitando o design já validado
  (`Vermelhinha_em_Numeros_Agosto2026.html`).

## Rodar local

```bash
npm install
APP_PASSWORD=suasenha npm start
# abre em http://localhost:4180  (login → /upload.html → painel)
```

Variáveis de ambiente:

| Var | Default | Uso |
|---|---|---|
| `PORT` | `4180` | porta HTTP |
| `APP_PASSWORD` | *(gera uma temporária e mostra no console)* | senha única da ferramenta |
| `SESSION_SECRET` | *(aleatória por boot)* | assina o cookie de sessão; defina em produção p/ sessão sobreviver a restart |
| `VA_DB_PATH` | `data/analytics.db` | caminho do SQLite |
| `VA_NO_AUTH` | — | `1` desliga a autenticação (**só para teste local**) |

`GET /healthz` responde sem login (para health check do provedor de hospedagem).

## Fluxo

1. `/upload.html` — escolhe loja + mês/ano, anexa o que tiver:
   - **Relatório de vendas (PDF)** — "Analítico de Vendas" do sistema. Obrigatório no
     primeiro envio de cada mês.
   - **Instagram** — formulário manual (6 métricas, valor + variação %), digitado olhando
     o print do Meta Business Suite.
   - **Concorrentes (xlsx)** — `Concorrentes_Coleta_AAAA-MM-DD.xlsx` (formato padrão de 36
     colunas). Opcional; sem ele, o painel mostra a seção "pendente".
2. O backend processa e grava. **Se a soma das transações do PDF não bater com o "Total:"
   impresso no rodapé, a análise é recusada** (nada é gravado, período não é criado) — regra
   de ouro do domínio.
3. `/` — painel, com seletor de loja e período no topo, e botão **"Baixar painel (HTML)"**
   que gera um arquivo `.html` autocontido (mesmo formato do painel manual antigo — abre
   sem servidor, dá para mandar por e-mail/WhatsApp). Rota: `GET /export/{loja}/{AAAA-MM}`.

### Cobertura do parser de vendas

Testado contra os 10 relatórios "Analítico de Vendas" reais em `C:\Users\Admin\Downloads\`
(de 1.391 a 72.480 linhas) — todos reconciliam **exatamente** com o "Total:" impresso.
Trata: coluna `Nº Cx` ausente, valores negativos de `ARREDONDAMENTO`, e detecção de dia
parcial (hora de fechamento por loja em `config/lojas.json` → `horaFechamento`). Rejeita
com mensagem clara PDFs que não são esse relatório (extrato bancário, NF-e, etc.).

### Radar de concorrência

Casa `Produto` + `Marca` da planilha com o que a loja vendeu no mês. A **Marca é filtro
duro**: "Loção Nivea" não casa com "FLETOP LOCAO", "Colgate Tripla Ação" não casa com
"COREGA ... TRIPLA ACAO". Ainda assim é leitura **direcional** (casamento aproximado de
nome) — o painel diz isso e mostra o nível de confiança de cada oferta. Concorrentes sem
coleta no período aparecem como "sem coleta", não somem.

## Regras não-negociáveis (implementadas)

- Minas Farma e Farma e Farma nunca são somadas juntas — toda agregação passa por
  `periodo_id`, que pertence a uma única loja.
- Painel não é publicado se a soma ≠ `Total:` do PDF — `parsers/vendas.js` lança e o
  endpoint responde erro sem tocar no banco.
- Categoria de produto é **estimada por palavra-chave** (`config/categorias.json`) — o
  painel avisa isso no rodapé e nos gráficos. Não é o cadastro do sistema.
- Dia parcial (relatório extraído no meio do dia/mês) é marcado como tal e **excluído do
  gráfico de tendência**, mantido só na tabela.
- Oferta de concorrente só entra na comparação se `Status validação = Confirmada` e não
  expirada; o nível de confiança aparece como badge.

## Estrutura

```
server.js            rotas (upload, leitura), auth por senha única, arquivos estáticos
db.js                node:sqlite — acesso, sempre por loja/período
schema.sql           tabelas
parsers/vendas.js    PDF "Analítico de Vendas" -> transações + validação da soma
parsers/instagram.js normaliza o formulário manual
parsers/concorrentes.js  xlsx 36 col -> ofertas confirmadas x nosso preço médio
classify.js          classificador de categoria (config/categorias.json)
aggregate.js         transações -> KPIs, série diária, dia da semana, categorias, top produtos
insights.js          3 regras automáticas -> cards (config/insights.json)
match.js             casamento de nome de produto (Jaccard de tokens), portado do app_minasfarma
config/              categorias.json · insights.json · lojas.json (dias de campanha, cards de concorrente)
public/              index.html (painel) · upload.html · painel.js · styles.css
test/                vendas.test.js (soma == Total impresso) · concorrentes.test.js (filtro de marca, datas, preços)
data/                analytics.db + uploads/<loja>/<ano-mes>/ (gitignored)
prompts/, schemas/   material de referência da Fase 2 (Motor de Análise Comercial) — ainda não implementada
```

## Testes

```bash
npm test
```

O teste do parser roda contra os PDFs reais de agosto/2026 em `C:\Users\Admin\Downloads\`
(`vendas agosto farma e farma.pdf` → R$ 196.566,57 / 4.169 vendas / 9.353 itens;
`vendas agosto minas farma.pdf` → R$ 478.723,02, incluindo linhas de ARREDONDAMENTO
negativas). Aponte para outro arquivo com `VENDAS_FIXTURE=<caminho>` /
`VENDAS_FIXTURE_MINAS=<caminho>`, ou copie um PDF para `test/fixtures/`.

## Deploy (futuro)

Render ou Railway (plano free cobre o uso). O SQLite precisa de **disco persistente**;
se o provedor não garantir, migrar para um Postgres gerenciado. `pdfjs-dist` não precisa
de pacote de sistema. Defina `APP_PASSWORD` e `SESSION_SECRET` no ambiente.

## Fase 2 — Motor de Análise Comercial (não implementada)

Camada de análise profunda mensal gerada por LLM (ver `prompts/motor-analise-comercial.md`).
O plano é: uma tarefa agendada externa aplica o prompt, valida contra o schema e faz
`POST /analise-comercial/upload` (com token); o backend só recebe, guarda e serve o JSON
em telas de scorecard. Nada disso existe ainda no código.
