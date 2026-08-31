export interface ConditionalWriteSettings {
  postgrestUrl: string;
  apiToken: string;
}

export interface ConditionalWritePayload {
  path: string;
  content: string;
  contentHash: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

export interface ConditionalRequest {
  url: string;
  method: "POST" | "PATCH";
  headers: Record<string, string>;
  body: string;
  throw: false;
}

interface ConditionalResponse {
  status: number;
  text: string;
  json: unknown;
}

type ConditionalTransport = (request: ConditionalRequest) => Promise<ConditionalResponse>;

export type ConditionalWriteResult = "applied" | "conflict";

export async function writeNoteConditionally(
  settings: ConditionalWriteSettings,
  id: string,
  vector: number[] | null,
  payload: ConditionalWritePayload,
  expectedRevision: number | undefined,
  request: ConditionalTransport,
): Promise<ConditionalWriteResult> {
  const updateExisting = expectedRevision !== undefined;
  const query = updateExisting
    ? `id=eq.${encodeURIComponent(id)}&sync_revision=eq.${expectedRevision}&select=sync_revision`
    : "on_conflict=id&select=sync_revision";
  const prefer = updateExisting ? "return=representation" : "resolution=ignore-duplicates,return=representation";
  const response = await request({
    url: `${settings.postgrestUrl}/notes?${query}`,
    method: updateExisting ? "PATCH" : "POST",
    headers: {
      "X-Api-Key": settings.apiToken,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify({
      id,
      path: payload.path,
      content: payload.content,
      content_hash: payload.contentHash,
      mtime: payload.mtime,
      size: payload.size,
      deleted: payload.deleted,
      embedding: vector,
    }),
    throw: false,
  });
  if (response.status >= 400) {
    throw new Error(`postgres-sync: conditional write ${payload.path} failed with ${response.status}: ${response.text}`);
  }
  return Array.isArray(response.json) && response.json.length > 0 ? "applied" : "conflict";
}
