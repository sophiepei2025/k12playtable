import type { IncomingMessage, ServerResponse } from "node:http";
import { handleActivities } from "../dist/src/api/handlers.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleActivities(req, res);
}
