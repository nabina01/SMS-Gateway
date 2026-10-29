FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY src ./src
COPY scripts ./scripts
COPY .env.example ./.env.example

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
