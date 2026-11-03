FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

# Build needs dev dependencies (vite); they are pruned after the build.
RUN npm ci && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build && npm prune --omit=dev

ENV NODE_ENV=production
# Database and job files live on a mounted volume so they survive rebuilds.
ENV DATABASE_URL=file:/data/bulkport.sqlite
ENV STORAGE_DIR=/data/storage

CMD ["npm", "run", "docker-start"]
