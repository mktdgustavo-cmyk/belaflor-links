# Bela Flor Links — imagem pronta para Easypanel / qualquer Docker
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/links.db \
    TZ_OFFSET_MINUTES=-180

COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /app/data

# Monte um volume aqui para não perder os links/cliques a cada deploy
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
