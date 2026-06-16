import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

const AZURA_URL = (process.env.AZURACAST_URL ?? "").replace(/\/$/, "");
const AZURA_KEY = process.env.AZURACAST_API_KEY ?? "";

export function validateEnv() {
  if (!AZURA_URL || !AZURA_KEY) {
    throw new Error(
      "Faltan variables de entorno: AZURACAST_URL y AZURACAST_API_KEY"
    );
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
  return str
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function registerTools(server: McpServer) {
  server.tool(
    "get_nowplaying",
    "Obtiene el now playing actual de una o todas las estaciones. Retorna artista, titulo, portada, duracion y oyentes.",
    {
      station_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe("ID o shortcode (opcional = todas las estaciones)"),
    },
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

  server.tool(
    "get_song_history",
    "Obtiene el historial reciente de canciones de una estacion.",
    {
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode"),
      rows: z.number().optional().default(10).describe("Cantidad (default 10)"),
    },
    async ({ station_id, rows }) => {
      const data = (await azuraFetch(
        `/api/station/${station_id}/history?rows=${rows}`
      )) as Array<Record<string, unknown>>;
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

  server.tool(
    "list_stations",
    "Lista todas las estaciones configuradas en AzuraCast.",
    {},
    async () => {
      const data = (await azuraFetch("/api/stations")) as Array<Record<string, unknown>>;
      const result = data.map((s) => ({
        id: s.id,
        shortcode: s.shortcode,
        name: s.name,
        is_public: s.is_public,
        listen_url: (s.listen_urls as Record<string, string>)?.http ?? "",
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_station",
    "Obtiene detalles de una estacion especifica.",
    { station_id: z.union([z.string(), z.number()]).describe("ID o shortcode") },
    async ({ station_id }) => {
      const data = await azuraFetch(`/api/station/${station_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "list_media",
    "Lista los archivos de media de una estacion para auditar metadata.",
    {
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(25),
    },
    async ({ station_id, page, per_page }) => {
      const data = await azuraFetch(
        `/api/station/${station_id}/files?page=${page}&per_page=${per_page}`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_media_metadata",
    "Actualiza el metadata (artista, titulo, album, genero, ano) de un track.",
    {
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode"),
      media_id: z.union([z.string(), z.number()]).describe("ID del archivo"),
      artist: z.string().optional(),
      title: z.string().optional(),
      album: z.string().optional(),
      genre: z.string().optional(),
      year: z.string().optional(),
    },
    async ({ station_id, media_id, ...fields }) => {
      const body: Record<string, unknown> = {};
      if (fields.artist !== undefined) body["artist"] = normalizeText(fields.artist);
      if (fields.title !== undefined) body["title"] = normalizeText(fields.title);
      if (fields.album !== undefined) body["album"] = fields.album;
      if (fields.genre !== undefined) body["genre"] = fields.genre;
      if (fields.year !== undefined) body["year"] = fields.year;
      const data = await azuraFetch(`/api/station/${station_id}/file/${media_id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "restart_station",
    "Reinicia una estacion de AzuraCast.",
    { station_id: z.union([z.string(), z.number()]).describe("ID o shortcode") },
    async ({ station_id }) => {
      const data = await azuraFetch(`/api/station/${station_id}/restart`, { method: "POST" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "skip_song",
    "Salta la cancion actual en una estacion (requiere AutoDJ activo).",
    { station_id: z.union([z.string(), z.number()]).describe("ID o shortcode") },
    async ({ station_id }) => {
      const data = await azuraFetch(`/api/station/${station_id}/backend/skip`, { method: "POST" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ─── NUEVA TOOL: download_track ───────────────────────────────────────────
  server.tool(
    "download_track",
    "Descarga audio de una URL (iVoox, YouTube, SoundCloud, etc.) usando yt-dlp y lo sube directamente a una estacion de AzuraCast. Requiere yt-dlp y ffmpeg instalados en el servidor.",
    {
      url: z.string().url().describe("URL del audio a descargar (iVoox, YouTube, SoundCloud, etc.)"),
      station_id: z.union([z.string(), z.number()]).describe("ID o shortcode de la estacion destino"),
      title: z.string().optional().describe("Titulo del track (opcional, se toma del metadata si no se indica)"),
      artist: z.string().optional().describe("Artista del track (opcional)"),
      subfolder: z.string().optional().default("").describe("Subcarpeta destino en AzuraCast (opcional, ej: 'podcasts')"),
    },
    async ({ url, station_id, title, artist, subfolder }) => {
      const tmpDir = await mkdtemp(join(tmpdir(), "ytdlp-"));
      const outputTemplate = join(tmpDir, "%(title)s.%(ext)s");

      // 1. Descargar con yt-dlp como mp3
      await execFileAsync("yt-dlp", [
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--no-playlist",
        "--output", outputTemplate,
        url,
      ]);

      // 2. Obtener el archivo descargado
      const { stdout: lsOut } = await execFileAsync("sh", ["-c", `ls "${tmpDir}"/*.mp3 2>/dev/null || ls "${tmpDir}"/* 2>/dev/null`]);
      const filePath = lsOut.trim().split("\n")[0];
      if (!filePath) throw new Error("yt-dlp no generó ningún archivo de audio.");

      const fileBuffer = await readFile(filePath);
      const fileName = filePath.split("/").pop() ?? "track.mp3";

      // 3. Subir a AzuraCast via multipart/form-data
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: "audio/mpeg" });
      const uploadPath = subfolder ? `${subfolder}/${fileName}` : fileName;
      formData.append("file", blob, uploadPath);

      const uploadRes = await fetch(`${AZURA_URL}/api/station/${station_id}/files`, {
        method: "POST",
        headers: { "X-API-Key": AZURA_KEY },
        body: formData,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Error al subir a AzuraCast: ${uploadRes.status} - ${errText}`);
      }

      const uploaded = await uploadRes.json() as Record<string, unknown>;

      // 4. Actualizar metadata si se proporcionó
      const mediaId = uploaded.id;
      if (mediaId && (title || artist)) {
        const metaBody: Record<string, string> = {};
        if (title) metaBody["title"] = normalizeText(title);
        if (artist) metaBody["artist"] = normalizeText(artist);
        await azuraFetch(`/api/station/${station_id}/file/${mediaId}`, {
          method: "PUT",
          body: JSON.stringify(metaBody),
        });
      }

      // 5. Limpiar temp
      await unlink(filePath).catch(() => {});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Track descargado y subido exitosamente a la estacion ${station_id}`,
            file: fileName,
            azuracast_id: mediaId ?? null,
            path: uploadPath,
          }, null, 2),
        }],
      };
    }
  );
}
