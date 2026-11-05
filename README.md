# autoflow

Automação de Instagram por fluxos (estilo ManyChat). Este é o **MVP1, sem IA**.

O que já funciona:

- conexão de qualquer conta Profissional com um clique (OAuth);
- comentário → resposta pública + DM privada;
- palavras-chave na DM, com tolerância a erros de digitação;
- menção em story, ice breakers e resposta padrão com cooldown;
- motor de fluxos com nós de mensagem, botões, respostas rápidas, carrossel, imagem, pergunta (com validação e timeout), condição, ação (tags, campos, webhook, passar para humano), atraso, randomizador e ir para outro fluxo;
- respeito à janela de 24h e cota de envio por hora;
- pausa automática do robô quando um humano responde pelo app do Instagram;
- versionamento de fluxos: as sessões em andamento não quebram quando um fluxo é editado;
- log de mensagens (base da inbox) e métricas por nó.

```
Instagram ──webhook──▶ API (Fastify) ──▶ Redis/BullMQ ──▶ Worker (motor de fluxos) ──▶ Graph API
                          │                                   │
                          └────────── Supabase Postgres ◀─────┘
```

## Estrutura

```
src/
  api/            servidor HTTP: webhooks, OAuth, rotas /admin
  worker/         processa a fila, jobs agendados e refresh de tokens
  engine/         motor de fluxos (engine.ts) e handlers dos nós (nodes.ts)
  flow/           schema do fluxo (zod), validação, payloads e config de gatilhos
  instagram/      OAuth, cliente da Graph API, normalização de webhooks
  store/          acesso a dados: Postgres (pg.ts) e memória (testes)
  lib/            crypto, texto/palavras-chave, variáveis, horário de funcionamento
supabase/migrations/   schema SQL
templates/restaurante.json   fluxo pronto para restaurantes
scripts/          migrate e seed
test/             testes do motor (vitest) e de integração
```

## Rodando local

Pré-requisitos: Node 20+, Docker Desktop e um túnel HTTPS (ngrok ou cloudflared), porque a Meta só envia webhooks para HTTPS público.

```bash
npm install
docker compose up -d          # Postgres + Redis
cp .env.example .env          # preencha (veja abaixo)
npm run db:migrate
npm run seed -- "Pizzaria do Zé"   # cria workspace + template e imprime o link de conexão
npm test                      # testes do motor

# em dois terminais:
npm run dev:api
npm run dev:worker

# túnel
ngrok http 3000               # coloque a URL em PUBLIC_BASE_URL
```

Para gerar os segredos do `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"      # STATE_SECRET / ADMIN_API_KEY
```

## Configurando o app na Meta

1. Em [developers.facebook.com](https://developers.facebook.com), crie um app do tipo **Business** e adicione o produto **Instagram**. Escolha **API setup with Instagram login**.
2. Copie o **Instagram App ID** e o **Instagram App Secret** para `IG_APP_ID` e `IG_APP_SECRET`.
3. Em **Configure webhooks**, preencha:
   - Callback URL: `https://SUA-URL/webhooks/instagram`
   - Verify token: o mesmo valor de `IG_WEBHOOK_VERIFY_TOKEN`
   - Assine os campos `messages`, `messaging_postbacks` e `comments`.
4. Em **Set up Instagram business login**, adicione a redirect URL `https://SUA-URL/auth/instagram/callback`.
5. Em **App settings → Basic**, preencha:
   - Deauthorize callback: `https://SUA-URL/auth/instagram/deauthorize`
   - Data deletion request: `https://SUA-URL/auth/instagram/data-deletion`
   - URL da política de privacidade
6. **Modo desenvolvimento:** só conectam contas adicionadas como **Instagram testers** (App roles). A pessoa aceita o convite em Instagram → Configurações → Apps e sites.
7. **Para abrir ao público:** faça o App Review das permissões `instagram_business_basic`, `instagram_business_manage_messages` e `instagram_business_manage_comments`, mais a Business Verification (CNPJ).

Se as DMs não chegarem, ative no Instagram da conta: Configurações → Mensagens → Ferramentas conectadas → **Permitir acesso a mensagens**.

> Os nomes de permissões e campos e a versão da Graph API (`IG_GRAPH_VERSION`) mudam com o tempo. Confira na documentação atual da Meta.

## Painel (web/)

O painel fica em `web/` (React + Vite) e usa o login do **Supabase Auth**.

```bash
npm run setup:web      # instala as dependências do painel (uma vez)
npm run dev            # sobe api + worker + ngrok + painel juntos
```

Abra **http://localhost:5173**, crie uma conta (e-mail e senha) e o seu primeiro negócio.

No `.env` da raiz, o backend precisa de:

```
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

O painel já vem configurado com o projeto do autoflow em `web/src/lib/supabase.ts`. Para trocar, crie `web/.env.local` com `VITE_SUPABASE_URL` e `VITE_SUPABASE_KEY`.

Telas: painel com métricas, editor visual de fluxos, gatilhos (com seletor de post), inbox com resposta humana, contatos com exportação CSV, conexão do Instagram e configurações (horário de funcionamento e pausa do robô).

## Publicações agendadas

Página **Publicações** do painel: agenda imagem ou Reels e, opcionalmente, já liga uma automação de comentários àquele post.

- O arquivo é enviado para a API (`POST /app/media`) e fica em `MEDIA_DIR` (padrão `uploads/`), servido em `PUBLIC_BASE_URL/media/...` — é dessa URL que a Meta baixa a mídia.
- O **worker** procura posts vencidos a cada `PUBLISH_POLL_SECONDS`, cria o contêiner na Meta, espera processar, publica e cria um gatilho de **comentário só para aquele post** (prioridade 100), apontando para o fluxo escolhido.
- Imagens são convertidas para JPG no navegador e cortadas para a proporção do feed (4:5 a 1,91:1). Reels: MP4/MOV, 3 s a 15 min.
- Exige a permissão de publicar: `instagram_content_publish` (login unificado/Facebook — adicione na configuração do login na Meta) ou `instagram_business_content_publish` (login do Instagram). Quem já conectou precisa reconectar uma vez para aceitar.
- Se o worker cair no meio, o post volta para a fila mantendo o contêiner (um contêiner só publica uma vez, então não duplica).

## Usando a API admin (sem painel)

Todas as rotas `/admin` exigem o header `x-api-key: ADMIN_API_KEY`.

| Método | Rota | Para quê |
|---|---|---|
| POST | `/admin/workspaces` | criar cliente `{ name, settings? }` |
| PATCH | `/admin/workspaces/:id` | ajustar `settings` (horário, fuso, pausa do robô) |
| POST | `/admin/workspaces/:id/connect-link` | link "Conectar Instagram" para mandar ao cliente |
| GET | `/admin/workspaces/:id/accounts` | contas conectadas |
| POST/PUT | `/admin/flows`, `/admin/flows/:id` | criar e editar o rascunho `{ graph }` |
| POST | `/admin/flows/:id/validate` | ver erros do grafo |
| POST | `/admin/flows/:id/publish` | publicar nova versão |
| GET | `/admin/flows/:id/stats?days=30` | métricas por nó |
| POST/PATCH/DELETE | `/admin/triggers` | gatilhos |
| POST | `/admin/accounts/:id/ice-breakers` | perguntas iniciais `{ items: [{ question, trigger_id }] }` |
| GET | `/admin/contacts?workspace_id=&tag=` | contatos com tags e campos |
| GET | `/admin/contacts/:id/messages` | histórico (inbox) |
| POST | `/admin/contacts/:id/resume-bot` | religar o robô depois de um atendimento humano |

Exemplo em PowerShell, criando um gatilho de comentário num post específico:

```powershell
$h = @{ "x-api-key" = "SUA_ADMIN_KEY" }
$body = @{
  workspace_id = "..."; flow_id = "..."; type = "comment"; priority = 10
  config = @{ media_id = "1789..."; keywords = @("eu quero"); public_replies = @("Te mandei no direct!") }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:3000/admin/triggers -Headers $h -Body $body -ContentType "application/json"
```

### Tipos de gatilho

| type | config |
|---|---|
| `comment` | `media_id` (null = qualquer post), `keywords` (vazio = qualquer comentário), `match`, `public_replies[]`, `once_per_contact` |
| `dm_keyword` | `keywords[]`, `match`: `contains` \| `exact` \| `starts_with` |
| `story_mention` | — |
| `postback` | `payload` (menu persistente ou payload próprio) |
| `default_reply` | `cooldown_minutes` |

Ordem de decisão quando chega uma DM:

1. clique em botão ou resposta rápida;
2. resposta a uma pergunta em aberto;
3. sessão aguardando a janela de 24h;
4. palavra-chave, pela prioridade;
5. resposta padrão.

### Formato do fluxo

Veja `templates/restaurante.json` e `src/flow/schema.ts`. Variáveis disponíveis nos textos: `{{first_name}}`, `{{username}}`, `{{field.endereco}}`, `{{var.x}}` e valor padrão com `{{first_name|amigo}}`.

O nó `webhook` envia um POST com o contato, tags, campos e vars. A resposta pode trazer `{ set_fields, set_vars, add_tags }`. É assim que você integra Pix, sistema do restaurante ou n8n.

### Regras do Instagram que o motor já trata

- **Resposta privada:** um comentário permite **uma** DM. As mensagens seguintes ficam em `waiting_window` até o cliente responder ou clicar num botão. Por isso, coloque botões na primeira mensagem.
- **Janela de 24h:** fora da janela, o envio é bloqueado e a sessão espera o cliente.
- **Cota por hora** (`hourly_send_limit` em `ig_accounts`, padrão 190): quando estoura, a sessão é retomada na hora seguinte.

## Deploy no Railway

Crie dois serviços a partir do mesmo repositório, mais um Redis:

| Serviço | Build | Start |
|---|---|---|
| api | `npm ci && npm run build` | `npm run start:api` |
| worker | `npm ci && npm run build` | `npm run start:worker` |

- Use o Postgres do Supabase em `DATABASE_URL` (connection string na porta 5432).
- Rode `npm run db:migrate` uma vez, ou cole `supabase/migrations/0001_init.sql` no SQL Editor.
- Defina `NODE_ENV=production` e as mesmas variáveis do `.env` nos dois serviços.

## Testes

```bash
npm test          # motor de fluxos com store em memória (28 casos)
npm run test:int  # Postgres + Redis reais (precisa do docker compose, migrate e seed)
```

## Próximos passos

- Painel em React: login com Supabase Auth, botão "Conectar Instagram", editor com React Flow e inbox em tempo real.
- Nó de Pix nativo e pedido estruturado.
- Envio em massa para contatos dentro da janela.
- MVP2: nós de IA ("entender intenção" e "resposta de FAQ").
