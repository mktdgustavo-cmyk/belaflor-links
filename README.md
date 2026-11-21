# Bela Flor Links

Encurtador de links com **rotação de comerciais**, **links com UTM** e **painel de análise**.
Zero dependências: só precisa de **Node.js 22.13+** (usa o SQLite que já vem no Node).

## Funcionalidades

- **Acesso por senha** simples (definida em `APP_PASSWORD`), com sessão de 30 dias e bloqueio após 10 tentativas erradas.
- **Rotação de comerciais**: um link (ex: `seudominio.com/comercial`) distribui os acessos entre N destinos pelo percentual definido.
  - Distribuição **exata** em sequência (round-robin ponderado), não sorteio: com 40/30/20/10, cada 100 acessos saem exatamente 40/30/20/10.
  - **Mesma pessoa → mesmo comercial** (opcional): quem clica de novo volta ao mesmo vendedor e não consome a vez de outro.
  - Pausar/ativar um comercial individualmente, ou removê-lo sem perder o histórico.
  - Pode colar só o número de WhatsApp (`5511999999999`), que vira `https://wa.me/...` automaticamente.
  - Ao editar percentuais, o balanceamento recomeça do zero com a nova meta.
- **Links com UTM**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `src`, `sck`, com prévia da URL final.
  - Opção de repassar parâmetros recebidos (ex: `fbclid`, `gclid`) para o destino.
- **Análise**: cliques, pessoas únicas, distribuição real × meta por comercial, cliques por dia, origem, dispositivo, horário e últimos acessos, além de exportação CSV.
  - Prévias de robôs (WhatsApp, Facebook, Telegram…) são **filtradas** e não contam nem consomem a rotação.

## Rodando

```bash
cp .env.example .env     # edite APP_PASSWORD e BASE_URL
npm start                # http://localhost:3000/admin
```

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

O banco fica em `./data/links.db` (faça backup dessa pasta).

### Sem Docker (PM2)

```bash
npm i -g pm2
pm2 start npm --name belaflor-links -- start
pm2 save && pm2 startup
```

### Nginx (HTTPS na frente)

```nginx
server {
  server_name links.belaflor.com.br;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Depois: `certbot --nginx -d links.belaflor.com.br`.

## Rotas

| Rota | O que é |
|---|---|
| `/admin` | Painel (pede a senha) |
| `/<slug>` | Link curto (redireciona) |
| `/` | Vai para o painel, ou para `ROOT_REDIRECT` se definido |
| `/health` | Health check |

Slugs reservados: `admin`, `api`, `assets`, `static`, `health`, `login`, `logout`.

## Como os números são contados

- **Cliques**: todo acesso válido (sem robôs).
- **Pessoas únicas**: visitantes distintos, identificados por cookie de primeira parte (mesmo aparelho/navegador).
- **Voltaram ao mesmo comercial**: cliques repetidos que foram para o vendedor já atribuído.
- O IP não é salvo, só um hash dele.
