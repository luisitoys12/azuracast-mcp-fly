# ---- Build ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Instalar python3, ffmpeg y yt-dlp
RUN apk add --no-cache python3 py3-pip ffmpeg curl \
  && pip3 install --break-system-packages yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Directorio temporal para descargas
RUN mkdir -p /tmp/ytdlp-downloads

EXPOSE 8080

CMD ["node", "dist/http.js"]
