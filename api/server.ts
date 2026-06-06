import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSkillerRequest } from "../src/server/index";

export const config = {
  maxDuration: 60,
};

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  request.url = normalizeVercelUrl(request.url);
  await handleSkillerRequest(request, response);
}

function normalizeVercelUrl(rawUrl: string | undefined): string {
  const parsed = new URL(rawUrl ?? "/", "http://skiller.local");
  const skillerPath = parsed.searchParams.get("__skiller_path");
  if (skillerPath === null || !skillerPath.startsWith("/")) {
    return rawUrl ?? "/";
  }

  parsed.searchParams.delete("__skiller_path");
  const query = parsed.searchParams.toString();
  return query.length === 0 ? skillerPath : `${skillerPath}?${query}`;
}
