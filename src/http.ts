import express from "express";
import { createServer } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateEnv, registerTools } from "./tools.js";

validateEnv();

const app = express();
app.use(express.json({ limit: "10mb" }));

const MCP_TOKEN = process.env.MCP_API_TOKEN ?? "";

// Health check para Fly.io
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "azuracast-mcp-fly",
    azuracast_url: process.env.AZURACAST_URL ?? "not set",
  });
});

// Endpoint MCP (Streamable HTTP)
app.all("/mcp", async (req, res) => {
  if (MCP_TOKEN) {
    const auth = req.headers["authorization"] ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== MCP_TOKEN) {
      res.status(401).json({ error: "Unauthorized: token invalido" });
      return;
    }
  }

  // Mantener conexion viva mientras yt-dlp descarga (Fly corta a los 60s sin datos)
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=600");

  try {
    const server = new McpServer({ name: "azuracast-mcp", version: "1.0.0" });
    registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    console.error(`[azuracast-mcp-fly] ERROR en /mcp handler:`);
    console.error(`[azuracast-mcp-fly] mensaje: ${message}`);
    if (stack) console.error(`[azuracast-mcp-fly] stack: ${stack}`);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
});

// Capturar errores no manejados para que aparezcan en fly logs
process.on("uncaughtException", (err) => {
  console.error(`[azuracast-mcp-fly] uncaughtException: ${err.message}`);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[azuracast-mcp-fly] unhandledRejection:`, reason);
});

const PORT = parseInt(process.env.PORT ?? "8080");

// Crear server HTTP con timeouts extendidos para descargas largas
const httpServer = createServer(app);
httpServer.keepAliveTimeout = 620_000;   // 620 segundos
httpServer.headersTimeout  = 630_000;   // ligeramente mayor que keepAliveTimeout

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[azuracast-mcp-fly] Servidor HTTP en puerto ${PORT}`);
  console.log(`[azuracast-mcp-fly] MCP endpoint  -> http://0.0.0.0:${PORT}/mcp`);
  console.log(`[azuracast-mcp-fly] Health check  -> http://0.0.0.0:${PORT}/health`);
  if (!MCP_TOKEN) {
    console.warn("[azuracast-mcp-fly] ADVERTENCIA: MCP_API_TOKEN no definido, endpoint publico");
  }
});
