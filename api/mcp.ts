import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHttpRequest } from "../dist/src/mcp/http.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleHttpRequest(req, res);
}
