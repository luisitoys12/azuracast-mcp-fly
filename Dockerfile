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

# Dependencias del sistema
RUN apk add --no-cache \
  python3 py3-pip ffmpeg curl \
  gcc musl-dev python3-dev libffi-dev

# yt-dlp + streamrip (Tidal, Qobuz, Deezer, SoundCloud)
RUN pip3 install --break-system-packages \
  yt-dlp \
  streamrip

# Configuracion base de streamrip (se sobreescribe con secrets en Fly)
RUN mkdir -p /root/.config/streamrip
COPY streamrip.toml /root/.config/streamrip/config.toml

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Directorio temporal para descargas
RUN mkdir -p /tmp/downloads

EXPOSE 8080

CMD ["node", "dist/http.js"]
