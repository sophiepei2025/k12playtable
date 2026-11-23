#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createExtracurricularMcpServer } from "./server.js";

// Local use (Claude Code / Claude Desktop / Antigravity): paid tools on, since it runs on your own machine.
const server = createExtracurricularMcpServer({ paid: process.env.MCP_LOCAL_PAID !== "false" });
await server.connect(new StdioServerTransport());
