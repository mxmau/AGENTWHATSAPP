FROM node:22-alpine

WORKDIR /app

# Instala dependências do sistema necessárias para Baileys
RUN apk add --no-cache \
  python3 \
  make \
  g++ \
  libc6-compat

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Diretório persistente para a sessão do WhatsApp e dados gerados
RUN mkdir -p auth_info_baileys generated-agents

EXPOSE 3001

ENV PORT=3001
ENV NODE_ENV=production

CMD ["node", "src/server.js"]
