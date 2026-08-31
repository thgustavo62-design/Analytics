# Integrações possíveis — Analytics

Levantamento de ferramentas que encaixam nas funcionalidades atuais do sistema
(pesquisa em 2026). Cada item traz: o que resolve, opção recomendada, esforço e risco.

> Ordem de prioridade sugerida no fim do arquivo.

---

## 1. Automatizar o "Analítico de Vendas" (maior ganho de autoalimentação)

**Hoje:** você exporta o PDF do sistema da farmácia e joga na pasta `inbox/`.

- **Leitura direta do PostgreSQL do ERP** — o Sysemp/ERPNexus tem um Postgres **local**
  rodando nesta máquina (`localhost:5432`, banco/schema `sysemp`; tabelas
  `nota_saida`, `nota_saida_itens`, `produto`, `marca`). O SQL do próprio relatório já
  está em `sysemp/Relatorio_Personalizados/vendas/`. Um módulo com o pacote `pg`
  consultaria isso a cada X horas e alimentaria o painel **sem nenhum PDF**.
  - *Precisa:* o usuário/senha atuais do Postgres (os dos scripts antigos não valem mais —
    banco foi para a versão 17). Peça ao suporte do Sysemp "acesso somente-leitura ao banco
    local para BI".
  - *Esforço:* médio. *Risco:* baixo (consulta read-only), mas é o banco de produção do ERP —
    consultas leves e fora do horário de pico.
- **Tarefa Agendada do Windows** que roda o export do relatório do mês-corrente e salva o
  PDF direto em `inbox/`. *Esforço:* baixo. *Risco:* nenhum. **Comece por aqui**, migre para
  o Postgres direto quando tiver a senha.

## 2. WhatsApp — entregar a análise e disparar alertas

**Hoje:** você abre o site para ver. Nada te avisa.

- **Evolution API** (open-source, Node, protocolo Baileys) — muito usada no Brasil em 2026,
  self-host, **não precisa de aprovação da Meta**. Um módulo `notify.js` mandaria:
  - resumo da Análise Comercial do mês (diagnóstico + decisão principal + link do painel);
  - alertas: "concorrente X abaixo do nosso preço em N itens de Fralda", "campanha de
    Limpeza rodando margem negativa 2 meses seguidos", "conta de convênio > 20% do mês".
  - *Alternativas:* **WhatsApp Business Cloud API** (oficial da Meta, exige verificação do
    Business Manager) · **Z-API** (SaaS BR pago, zero configuração de servidor).
  - *Esforço:* médio (subir a Evolution + `notify.js`). *Recomendado:* Evolution self-host;
    Z-API se não quiser manter servidor.

## 3. Instagram Insights — acabar com o formulário manual

**Hoje:** você digita 6 métricas olhando o print do Meta Business Suite.

- **Meta Graph API v22** (`GET /{ig-user-id}/insights`) para conta **Instagram Business**:
  `reach`, `views`, `accounts_engaged`, `total_interactions`, `follower_count`.
  - *Ressalva:* a Meta descontinuou (jan/2025) `profile_views`, `website_clicks`,
    `phone_call_clicks` na série temporal — "visitas ao perfil" e "cliques no link" do
    formulário podem não vir pela API; alcance, interações e seguidores vêm. Retenção de
    90 dias → puxar 1x/mês.
  - *Precisa:* app no Meta for Developers, conta IG Business vinculada a uma página, token
    de longa duração, ≥ 100 seguidores.
  - *Esforço:* médio (a dança do OAuth é o chato). Se não tiver conta Business configurada,
    mantenha o formulário.

## 4. Preços de concorrentes — reduzir a leitura manual dos encartes

**Hoje:** você lê o carrossel do Instagram do concorrente e preenche a planilha
`Concorrentes_Coleta_*.xlsx`.

- **OCR + visão nas imagens do encarte**: `tesseract.js` (grátis, ~60–90% em texto de
  encarte limpo) com **fallback no Claude vision** (já temos o `@anthropic-ai/sdk`) para as
  imagens que o Tesseract erra. Saída pré-preenchida na planilha para você **confirmar**
  antes de salvar (OCR de preço erra fácil — nunca salvar sem revisão humana).
- **Referência de preço-teto**: **PharmaDB** ou **Medicamentos API.br** (preços máximos
  CMED/ANVISA por princípio ativo) — dá para sinalizar "nosso preço acima do PMC" e ter uma
  régua para a comparação. *CliqueFarma / Consulta Remédios* não têm API pública.
- *Esforço:* médio. *Recomendado:* screenshot do carrossel → Claude vision → pré-preenche a
  planilha → você confirma.

## 5. BI self-service (perguntas ad-hoc além do painel)

- **Metabase** (open-source AGPL, self-host grátis via Docker/JAR) conecta em `data/analytics.db`
  em ~5 min. Bom para você fatiar os dados sozinho sem depender de uma tela nova no código.
- *Esforço:* baixo. *Quando:* só se quiser explorar os dados por conta própria.

## 6. Acesso remoto (ver do celular, fora da farmácia)

- **Cloudflare Tunnel** (plano Zero Trust free, $0, domínio próprio, só saída — sem abrir
  porta no roteador), com **Cloudflare Access** (login por e-mail) na frente.
  - *Alternativa:* **Tailscale Funnel** (hostname fixo, até 6 usuários no free). O free do
    **ngrok** foi muito cortado em fev/2026 (1 GB, sessão de 2h, página de aviso).
- *Esforço:* baixo. *Recomendado:* Cloudflare Tunnel + Access.

## 7. Backup do banco

Agora **tudo** está em `data/analytics.db` (vendas, Instagram, concorrência, análises).

- **Litestream** (replicação contínua de SQLite para S3/Backblaze B2 — feito pra isso) ou
  um `rclone copy` noturno para Google Drive / B2.
- *Esforço:* baixo. *Recomendado:* Litestream.

## 8. Rodar como serviço do Windows

- **nssm** (`nssm install Analytics`) roda o `node server.js` como serviço — sobe sozinho
  no boot, sem janela. A verificação diária da análise já é interna (não precisa de cron
  externo).
- *Esforço:* baixo.

## 9. E-mail (alternativa/além do WhatsApp)

- **Resend** ou SMTP — manda a Análise Comercial do mês por e-mail. O `/export-analise/...`
  já gera o HTML autocontido pronto para anexar.
- *Esforço:* baixo.

## 10. Google Sheets (se a equipe vive em planilha)

- **Google Sheets API** — empurra KPIs e a comparação com concorrentes para uma planilha
  compartilhada que o pessoal já usa.
- *Esforço:* baixo–médio.

---

## Ordem sugerida

1. **Tarefa Agendada** exportando o relatório para `inbox/` (hoje, risco zero).
2. **nssm** + **Cloudflare Tunnel/Access** — servidor sempre no ar e acessível do celular.
3. **Litestream** — backup do banco.
4. **WhatsApp (Evolution API)** — resumo mensal + alertas.
5. **Postgres do ERP direto** — quando tiver a senha; aposenta o PDF.
6. **OCR/visão nos encartes** e **Instagram Graph API** — aposentam as duas entradas
   manuais que sobraram.
7. **Metabase** e **Sheets** — conforme a necessidade de explorar/compartilhar.

## Fontes

- Evolution API — https://github.com/evolution-foundation/evolution-api ·
  https://docs.evolutionfoundation.com.br/evolution-api
- Instagram Graph API 2026 — https://developers.facebook.com/docs/instagram-platform/insights/ ·
  https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/
- Metabase + SQLite — https://www.metabase.com/data-sources/sqlite
- Túneis (Cloudflare/Tailscale/ngrok) 2026 — https://devopsboys.com/blog/cloudflare-tunnel-vs-ngrok-vs-tailscale-2026 ·
  https://merginit.com/blog/19062026-free-developer-tunnels-comparison
- APIs de medicamentos BR — https://pharmadb.com.br/ · https://medicamentos.api.br/
- OCR (Tesseract vs Vision) 2026 — https://dev.to/gabrielanhaia/vision-models-for-ocr-when-they-beat-tesseract-and-when-they-dont-54a6 ·
  https://imagetotable.ai/blog/best-ocr-api-2026
