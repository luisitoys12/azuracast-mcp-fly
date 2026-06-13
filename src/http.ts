import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateEnv, registerTools } from "./tools.js";

validateEnv();

const app = express();
app.use(express.json());

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

  const server = new McpServer({ name: "azuracast-mcp", version: "1.0.0" });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = parseInt(process.env.PORT ?? "8080");
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[azuracast-mcp-fly] Servidor HTTP en puerto ${PORT}`);
  console.log(`[azuracast-mcp-fly] MCP endpoint  -> http://0.0.0.0:${PORT}/mcp`);
  console.log(`[azuracast-mcp-fly] Health check  -> http://0.0.0.0:${PORT}/health`);
  if (!MCP_TOKEN) {
    console.warn("[azuracast-mcp-fly] ADVERTENCIA: MCP_API_TOKEN no definido, endpoint publico");
  }
});
