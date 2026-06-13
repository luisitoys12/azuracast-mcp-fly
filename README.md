# azuracast-mcp-fly

> MCP Server para [AzuraCast](https://www.azuracast.com/) deployado en **[Fly.io](https://fly.io)** con Docker + Streamable HTTP.

## Herramientas disponibles

| Tool | Descripcion |
|------|-------------|
| `get_nowplaying` | Now playing actual (artista, titulo, portada, oyentes) |
| `get_song_history` | Historial reciente de canciones |
| `list_stations` | Lista todas las estaciones con ID y URL |
| `get_station` | Detalles completos de una estacion |
| `list_media` | Lista archivos de media con metadata |
| `update_media_metadata` | Actualiza artista, titulo, album, genero y ano de un track |
| `restart_station` | Reinicia una estacion |
| `skip_song` | Salta la cancion actual (requiere AutoDJ activo) |

---

## Requisitos previos

- Cuenta en [Fly.io](https://fly.io) (hay tier gratuito)
- [flyctl](https://fly.io/docs/flyctl/install/) instalado
- Node.js >= 18 (para desarrollo local)
- Git

---

## Deploy en Fly.io paso a paso

### 1. Instalar flyctl

```bash
# macOS / Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex

# Termux (Android)
curl -L https://fly.io/install.sh | sh
```

### 2. Login en Fly.io

```bash
flyctl auth login
```

### 3. Clonar el repo

```bash
git clone https://github.com/luisitoys12/azuracast-mcp-fly
cd azuracast-mcp-fly
```

### 4. Crear la app en Fly.io

```bash
# Esto registra tu app con el nombre del fly.toml
flyctl apps create azuracast-mcp-fly
```

Si el nombre ya esta tomado, edita la linea `app = 'azuracast-mcp-fly'` en `fly.toml` con un nombre unico, por ejemplo `azuracast-mcp-kusmedios`.

### 5. Configurar los secrets (variables de entorno)

```bash
flyctl secrets set \
  AZURACAST_URL="https://radio.kusmedios.lat" \
  AZURACAST_API_KEY="TU_API_KEY_AQUI" \
  MCP_API_TOKEN="pon-aqui-un-token-secreto-largo"
```

> Puedes generar un token seguro con:
> ```bash
> openssl rand -hex 32
> ```

### 6. Deploy

```bash
flyctl deploy
```

Fly.io construye la imagen Docker, la sube y levanta la app automaticamente. El primer deploy tarda ~2-3 minutos.

### 7. Verificar que funciona

```bash
# Ver logs en vivo
flyctl logs

# Health check
curl https://azuracast-mcp-fly.fly.dev/health
```

Deberias ver:
```json
{ "status": "ok", "service": "azuracast-mcp-fly", "azuracast_url": "https://radio.kusmedios.lat" }
```

---

## Comandos utiles de flyctl

```bash
# Ver estado de la app
flyctl status

# Ver logs en tiempo real
flyctl logs

# Actualizar secrets
flyctl secrets set AZURACAST_API_KEY="nueva_key"

# Redeploy (tras cambios en el codigo)
flyctl deploy

# Escalar a 0 (apagar sin borrar)
flyctl scale count 0

# Volver a encender
flyctl scale count 1

# Ver consumo de recursos
flyctl status --verbose

# Abrir la app en el browser
flyctl open /health
```

---

## URL de tu MCP server

Despues del deploy tu endpoint queda en:

```
https://azuracast-mcp-fly.fly.dev/mcp
https://azuracast-mcp-fly.fly.dev/health
```

---

## Configurar en Claude Desktop

Edita `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "azuracast": {
      "url": "https://azuracast-mcp-fly.fly.dev/mcp",
      "headers": {
        "Authorization": "Bearer TU_MCP_API_TOKEN"
      }
    }
  }
}
```

---

## Configurar en n8n

1. Agrega nodo **MCP Client**.
2. Tipo de conexion: `Streamable HTTP`.
3. URL: `https://azuracast-mcp-fly.fly.dev/mcp`
4. Header: `Authorization: Bearer TU_MCP_API_TOKEN`

---

## Desarrollo local

```bash
npm install
cp .env.example .env
# Edita .env con tus valores reales
npm run dev
```

Eso levanta el servidor en `http://localhost:8080`.

---

## Variables de entorno

| Variable | Requerida | Descripcion |
|---|---|---|
| `AZURACAST_URL` | Si | URL base de tu AzuraCast (sin trailing slash) |
| `AZURACAST_API_KEY` | Si | API Key de AzuraCast |
| `MCP_API_TOKEN` | Recomendado | Token Bearer para proteger el endpoint HTTP |
| `PORT` | No | Puerto (Fly.io usa 8080 automaticamente) |

> **Nunca subas tu `.env` a GitHub.** Ya esta en `.gitignore`.

---

## Tier gratuito de Fly.io

Fly.io incluye en su plan gratuito:
- 3 VMs compartidas de 256 MB
- No duerme automaticamente (a diferencia de Render free)
- 160 GB de transferencia/mes
- Ideal para este tipo de microservicio

---

## Licencia

MIT - hecho con para [EstacionKusmedios](https://estacionkusmedios.org)
