import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { unlink, readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

const AZURA_URL = (process.env.AZURACAST_URL ?? "").replace(/\/$/, "");
const AZURA_KEY = process.env.AZURACAST_API_KEY ?? "";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/tmp/downloads";

export function validateEnv() {
  if (!AZURA_URL || !AZURA_KEY) {
    throw new Error("Faltan variables de entorno: AZURACAST_URL y AZURACAST_API_KEY");
  }
}

async function azuraFetch(path: string, options: RequestInit = {}) {
  const url = `${AZURA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-Key": AZURA_KEY,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AzuraCast API error ${res.status}: ${text}`);
  }
  return res.json();
}

function normalizeText(str: string): string {
  if (!str) return "";
  return str.trim().replace(/\s+/g, " ")
    .split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Upload via curl para evitar cargar el archivo en RAM de Node
// curl hace streaming directo desde disco → AzuraCast API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function uploadFileToAzura(
  filePath: string,
  stationId: string | number,
  subfolder: string,
  metaTitle?: string,
  metaArtist?: string
): Promise<Record<string, unknown>> {
  const fileName = filePath.split("/").pop() ?? "track.mp3";
  const uploadPath = subfolder ? `${subfolder}/${fileName}` : fileName;

  // Usar curl para stream directo desde disco sin pasar por RAM de Node
  const curlCmd = [
    `curl -s -X POST`,
    `-H "X-API-Key: ${AZURA_KEY}"`,
    `-F "file=@${filePath};filename=${uploadPath}"`,
    `"${AZURA_URL}/api/station/${stationId}/files"`,
  ].join(" ");

  const { stdout } = await execAsync(curlCmd, { maxBuffer: 1024 * 1024 });
  const uploaded = JSON.parse(stdout) as Record<string, unknown>;

  if (!uploaded.id) {
    throw new Error(`AzuraCast no retornó ID: ${stdout}`);
  }

  // Actualizar metadata si se proporcionó
  if (metaTitle || metaArtist) {
    const metaBody: Record<string, string> = {};
    if (metaTitle) metaBody["title"] = normalizeText(metaTitle);
    if (metaArtist) metaBody["artist"] = normalizeText(metaArtist);
    await azuraFetch(`/api/station/${stationId}/file/${uploaded.id}`, {
      method: "PUT",
      body: JSON.stringify(metaBody),
    });
  }

  // Limpiar archivo temporal
  await unlink(filePath).catch(() => {});
  return uploaded;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// yt-dlp con memoria limitada: sin buffer en RAM, escribe a disco
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function ytdlpDownload(url: string, outputTemplate: string, extraArgs: string[] = []): Promise<void> {
  const args = [
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "5",        // calidad media para reducir uso de ffmpeg
    "--no-playlist",
    "--buffer-size", "16K",        // buffer minimo en RAM
    "--http-chunk-size", "1M",     // descarga en chunks de 1MB
    "--no-part",                   // no archivo .part intermedio
    "--no-mtime",
    "--output", outputTemplate,
    ...extraArgs,
    url,
  ].join(" ");

  await execAsync(`yt-dlp ${args}`, {
    maxBuffer: 512 * 1024,  // stdout/stderr max 512KB
    timeout: 300000,         // timeout 5 minutos
    env: {
      ...process.env,
      // Limitar memoria virtual de ffmpeg
      MALLOC_ARENA_MAX: "2",
    },
  });
}

export function registerTools(server: McpServer) {

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TOOLS ORIGINALES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool("get_nowplaying",
    "Obtiene el now playing actual de una o todas las estaciones.",
    { station_id: z.union([z.string(), z.number()]).optional().describe("ID o shortcode (opcional = todas)") },
    async ({ station_id }) => {
      const path = station_id ? `/api/nowplaying/${station_id}` : "/api/nowplaying";
      const data = await azuraFetch(path);
      const format = (entry: Record<string, unknown>) => {
        const np = (entry.now_playing ?? entry) as Record<string, unknown>;
        const song = (np.song ?? {}) as Record<string, string>;
        return {
          station: (entry.station as Record<string, string>)?.name ?? "Estacion",
          artist: normalizeText(song.artist ?? ""),
          title: normalizeText(song.title ?? ""),
          display: `${normalizeText(song.artist ?? "")} - ${normalizeText(song.title ?? "")}`,
          art: song.art ?? "",
          elapsed: (np.elapsed as number) ?? 0,
          duration: (np.duration as number) ?? 0,
          listeners: (entry.listeners as Record<string, number>)?.current ?? 0,
        };
      };
      const result = Array.isArray(data) ? data.map(format) : [format(data)];
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("get_song_history",
    "Obtiene el historial reciente de canciones de una estacion.",
    {
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode"),
      rows: z.number().optional().default(10).describe("Cantidad (default 10)"),
    },
    async ({ station_id, rows }) => {
      const data = (await azuraFetch(`/api/station/${station_id}/history?rows=${rows}`)) as Array<Record<string, unknown>>;
      const result = data.map((entry) => {
        const song = (entry.song ?? {}) as Record<string, string>;
        return {
          artist: normalizeText(song.artist ?? ""),
          title: normalizeText(song.title ?? ""),
          display: `${normalizeText(song.artist ?? "")} - ${normalizeText(song.title ?? "")}`,
          played_at: entry.played_at,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("list_stations", "Lista todas las estaciones configuradas en AzuraCast.", {},
    async () => {
      const data = (await azuraFetch("/api/stations")) as Array<Record<string, unknown>>;
      const result = data.map((s) => ({
        id: s.id, shortcode: s.shortcode, name: s.name,
        is_public: s.is_public,
        listen_url: (s.listen_urls as Record<string, string>)?.http ?? "",
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool("get_station", "Obtiene detalles de una estacion especifica.",
    { station_id: z.union([z.string(), z.number()]).describe("ID o shortcode") },
    async ({ station_id }) => {
      const data = await azuraFetch(`/api/station/${station_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("list_media", "Lista los archivos de media de una estacion.",
    {
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(25),
    },
    async ({ station_id, page, per_page }) => {
      const data = await azuraFetch(`/api/station/${station_id}/files?page=${page}&per_page=${per_page}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("update_media_metadata", "Actualiza el metadata de un track en AzuraCast.",
    {
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode"),
      media_id: z.union([z.string(), z.number()]).describe("ID del archivo"),
      artist: z.string().optional(), title: z.string().optional(),
      album: z.string().optional(), genre: z.string().optional(), year: z.string().optional(),
    },
    async ({ station_id, media_id, ...fields }) => {
      const body: Record<string, unknown> = {};
      if (fields.artist !== undefined) body["artist"] = normalizeText(fields.artist);
      if (fields.title !== undefined) body["title"] = normalizeText(fields.title);
      if (fields.album !== undefined) body["album"] = fields.album;
      if (fields.genre !== undefined) body["genre"] = fields.genre;
      if (fields.year !== undefined) body["year"] = fields.year;
      const data = await azuraFetch(`/api/station/${station_id}/file/${media_id}`, { method: "PUT", body: JSON.stringify(body) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("restart_station", "Reinicia una estacion de AzuraCast.",
    { station_id: z.union([z.string(), z.number()]).describe("ID o shortcode") },
    async ({ station_id }) => {
      const data = await azuraFetch(`/api/station/${station_id}/restart`, { method: "POST" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("skip_song", "Salta la cancion actual en una estacion (requiere AutoDJ activo).",
    { station_id: z.union([z.string(), z.number()]).describe("ID o shortcode") },
    async ({ station_id }) => {
      const data = await azuraFetch(`/api/station/${station_id}/backend/skip`, { method: "POST" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // NUEVAS TOOLS: DESCARGA
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  server.tool("download_track",
    "Descarga un track de cualquier URL soportada por yt-dlp (iVoox, YouTube, SoundCloud, Mixcloud, etc.) y lo sube directamente a AzuraCast.",
    {
      url: z.string().url().describe("URL del audio (iVoox, YouTube, SoundCloud, etc.)"),
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode de la estacion destino"),
      title: z.string().optional().describe("Titulo del track (opcional)"),
      artist: z.string().optional().describe("Artista (opcional)"),
      subfolder: z.string().optional().default("").describe("Subcarpeta destino en AzuraCast (ej: 'podcasts')"),
    },
    async ({ url, station_id, title, artist, subfolder }) => {
      const fileId = `ytdlp_${Date.now()}`;
      const outTemplate = join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

      await ytdlpDownload(url, outTemplate);

      const files = (await readdir(DOWNLOAD_DIR)).filter(f => f.startsWith(fileId));
      if (!files.length) throw new Error("yt-dlp no genero ningun archivo.");
      const filePath = join(DOWNLOAD_DIR, files[0]);

      const fileStats = await stat(filePath);
      const uploaded = await uploadFileToAzura(filePath, station_id, subfolder ?? "", title, artist);

      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true,
          message: `Track descargado y subido a estacion ${station_id}`,
          file: files[0],
          size_mb: (fileStats.size / 1024 / 1024).toFixed(2),
          azuracast_id: uploaded.id ?? null,
        }, null, 2) }],
      };
    }
  );

  server.tool("download_playlist_ytdlp",
    "Descarga una playlist completa desde YouTube, SoundCloud u otras plataformas soportadas por yt-dlp y sube todos los tracks a AzuraCast. Ideal para importar podcasts o programas completos.",
    {
      url: z.string().url().describe("URL de la playlist o canal"),
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode de la estacion destino"),
      subfolder: z.string().optional().default("").describe("Subcarpeta destino en AzuraCast"),
      max_tracks: z.number().optional().default(20).describe("Maximo de tracks a descargar (default 20)"),
    },
    async ({ url, station_id, subfolder, max_tracks }) => {
      const batchId = `pl_${Date.now()}`;
      const outTemplate = join(DOWNLOAD_DIR, `${batchId}_%(playlist_index)s.%(ext)s`);

      await ytdlpDownload(url, outTemplate, ["--playlist-end", String(max_tracks)]);

      const files = (await readdir(DOWNLOAD_DIR)).filter(f => f.startsWith(batchId));
      if (!files.length) throw new Error("No se descargo ningun archivo.");

      const results = [];
      for (const file of files.sort()) {
        const filePath = join(DOWNLOAD_DIR, file);
        try {
          const uploaded = await uploadFileToAzura(filePath, station_id, subfolder ?? "");
          results.push({ file, azuracast_id: uploaded.id ?? null, status: "ok" });
        } catch (e) {
          results.push({ file, status: "error", error: String(e) });
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true, total: results.length, tracks: results,
        }, null, 2) }],
      };
    }
  );

  server.tool("download_tidal",
    "Descarga un track, album o playlist de Tidal usando streamrip y lo sube a AzuraCast. Requiere TIDAL_ACCESS_TOKEN configurado en Fly secrets.",
    {
      url: z.string().url().describe("URL de Tidal (track, album o playlist)"),
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode de la estacion destino"),
      subfolder: z.string().optional().default("tidal").describe("Subcarpeta destino (default: 'tidal')"),
    },
    async ({ url, station_id, subfolder }) => {
      const tidalToken = process.env.TIDAL_ACCESS_TOKEN ?? "";
      const tidalRefresh = process.env.TIDAL_REFRESH_TOKEN ?? "";
      if (!tidalToken) throw new Error("Falta TIDAL_ACCESS_TOKEN en Fly secrets. Configura: fly secrets set TIDAL_ACCESS_TOKEN=xxx");

      const { writeFile } = await import("fs/promises");
      const configPatch = `[downloads]\nfolder = "${DOWNLOAD_DIR}"\n\n[tidal]\naccess_token = "${tidalToken}"\nrefresh_token = "${tidalRefresh}"\nquality = 1\n`;
      await writeFile("/root/.config/streamrip/config.toml", configPatch);

      await execAsync(`rip url "${url}"`, { timeout: 300000, maxBuffer: 512 * 1024 });

      const files = (await readdir(DOWNLOAD_DIR)).filter(f => f.endsWith(".mp3") || f.endsWith(".flac"));
      if (!files.length) throw new Error("streamrip no genero archivos de audio.");

      const results = [];
      for (const file of files) {
        const filePath = join(DOWNLOAD_DIR, file);
        try {
          const uploaded = await uploadFileToAzura(filePath, station_id, subfolder ?? "tidal");
          results.push({ file, azuracast_id: uploaded.id ?? null, status: "ok" });
        } catch (e) {
          results.push({ file, status: "error", error: String(e) });
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true, source: "tidal", total: results.length, tracks: results,
        }, null, 2) }],
      };
    }
  );

  server.tool("download_qobuz",
    "Descarga un track, album o playlist de Qobuz usando streamrip y lo sube a AzuraCast. Requiere QOBUZ_EMAIL y QOBUZ_PASSWORD en Fly secrets.",
    {
      url: z.string().url().describe("URL de Qobuz (track, album o playlist)"),
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode de la estacion destino"),
      subfolder: z.string().optional().default("qobuz").describe("Subcarpeta destino (default: 'qobuz')"),
    },
    async ({ url, station_id, subfolder }) => {
      const email = process.env.QOBUZ_EMAIL ?? "";
      const password = process.env.QOBUZ_PASSWORD ?? "";
      if (!email || !password) throw new Error("Faltan QOBUZ_EMAIL y QOBUZ_PASSWORD en Fly secrets.");

      const { writeFile } = await import("fs/promises");
      const configPatch = `[downloads]\nfolder = "${DOWNLOAD_DIR}"\n\n[qobuz]\nemail_or_userid = "${email}"\npassword_or_token = "${password}"\nquality = 1\n`;
      await writeFile("/root/.config/streamrip/config.toml", configPatch);

      await execAsync(`rip url "${url}"`, { timeout: 300000, maxBuffer: 512 * 1024 });

      const files = (await readdir(DOWNLOAD_DIR)).filter(f => f.endsWith(".mp3") || f.endsWith(".flac"));
      if (!files.length) throw new Error("streamrip no genero archivos de audio.");

      const results = [];
      for (const file of files) {
        const filePath = join(DOWNLOAD_DIR, file);
        try {
          const uploaded = await uploadFileToAzura(filePath, station_id, subfolder ?? "qobuz");
          results.push({ file, azuracast_id: uploaded.id ?? null, status: "ok" });
        } catch (e) {
          results.push({ file, status: "error", error: String(e) });
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: true, source: "qobuz", total: results.length, tracks: results,
        }, null, 2) }],
      };
    }
  );
}
