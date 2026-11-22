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
- **Links com UTM**: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `src`, `sck` e **`coupon` (cupom Hubla)**, com prévia da URL final.
  - Opção de repassar parâmetros recebidos (ex: `fbclid`, `gclid`) para o destino.
- **Grava as UTMs recebidas**: quem acessa `links.../comercial?utm_source=facebook&utm_campaign=bf26` tem `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `src`, `sck` e `coupon` salvos no clique.
  - O painel mostra o ranking por campo e por combinação source / medium / campaign. Na rotação, mostra também quantos leads de cada UTM foram para cada comercial.
  - As UTMs saem no CSV e na lista de últimos acessos.
- **Código do lead + exportação**: cada acesso ganha um código (ex: `K7Q3X`) que vai na mensagem automática do WhatsApp, como em *"Olá! Vim pelo link da Bela Flor. (Código: {codigo})"*.
  - Variáveis da mensagem: `{codigo}`, `{comercial}`, `{utm_source}`, `{utm_medium}`, `{utm_campaign}`, `{utm_content}`, `{utm_term}`, `{cupom}`.
  - A mesma pessoa clicando de novo no mesmo comercial mantém o código.
  - **Exportar leads** (por link ou todos): uma linha por lead com código, data, comercial que recebeu, UTMs, dispositivo e origem.
  - **Buscar código** no painel: o comercial digita o código da mensagem e vê de onde veio o lead.
- **Análise**: cliques, pessoas únicas, distribuição real × meta por comercial, cliques por dia, origem, dispositivo, horário e últimos acessos, além de exportação CSV.
  - Prévias de robôs (WhatsApp, Facebook, Telegram…) são **filtradas** e não contam nem consomem a rotação.

## Deploy no Easypanel

1. **Create Service → App**.
2. **Source**: GitHub (este repositório) com **Build: Dockerfile**. Sem GitHub, dá para subir a imagem pronta em *Docker Image*.
3. **Environment**:
   ```
   APP_PASSWORD=sua-senha-forte
   BASE_URL=https://links.belaflor.com.br
   ```
4. **Mounts → Volume**: name `data`, mount path **`/app/data`**. *Sem isso, os links e cliques se perdem a cada deploy.*
5. **Domains**: aponte o domínio para a **porta 3000** (o HTTPS é feito pelo Easypanel).
6. Deploy e acesse `https://seu-dominio/admin`.

O container tem healthcheck em `/health`.

## Rodando local

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
