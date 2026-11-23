import type { IncomingMessage, ServerResponse } from "node:http";
import { handleParseQuery } from "../dist/src/api/handlers.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleParseQuery(req, res);
}
