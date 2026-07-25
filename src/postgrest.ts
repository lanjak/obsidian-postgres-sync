import { requestUrl } from "obsidian";

export interface NotePayload {
  path: string;
  content: string;
  contentHash: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

export interface NoteRow {
  id: string;
  payload: NotePayload;
}

interface NoteRowJson {
  id: string;
  path: string;
  content: string;
  content_hash: string;
  mtime: number;
  size: number;
  deleted: boolean;
}

function rowToNoteRow(row: NoteRowJson): NoteRow {
  return {
    id: row.id,
    payload: {
      path: row.path,
      content: row.content,
      contentHash: row.content_hash,
      mtime: row.mtime,
      size: row.size,
      deleted: row.deleted,
    },
  };
}

/** Deterministic UUID (v4-shaped, not cryptographically meaningful) from a vault path, so renames/moves are the only case that needs a delete+create pair. */
export async function pathToId(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface EmbedSettings {
  embedUrl: string;
  embedApiKey: string;
}

export async function embed(settings: EmbedSettings, text: string, task: "search_document" | "search_query"): Promise<number[]> {
  const res = await requestUrl({
    url: `${settings.embedUrl}/embedding`,
    method: "POST",
    contentType: "application/json",
    headers: settings.embedApiKey ? { Authorization: `Bearer ${settings.embedApiKey}` } : undefined,
    body: JSON.stringify({ content: `${task}: ${text}` }),
  });
  const body = res.json as Array<{ embedding: number[][] }>;
  return body[0].embedding[0];
}

interface PostgrestSettings {
  postgrestUrl: string;
  apiToken: string;
}

/** X-Api-Key, not Authorization - PostgREST tries to parse an Authorization header as a JWT before db-pre-request runs, which fails with an unrelated 500 when no JWT secret is configured. See sql/schema.sql's comment on check_bearer_token(). */
function headers(settings: PostgrestSettings, extra?: Record<string, string>): Record<string, string> {
  return {
    "X-Api-Key": settings.apiToken,
    "Content-Type": "application/json",
    ...extra,
  };
}

function throwOnError(res: { status: number; text: string }, context: string): void {
  if (res.status >= 400) {
    throw new Error(`postgres-sync: ${context} failed with ${res.status}: ${res.text}`);
  }
}

export async function upsertNote(settings: PostgrestSettings, id: string, vector: number[] | null, payload: NotePayload): Promise<void> {
  const res = await requestUrl({
    url: `${settings.postgrestUrl}/notes?on_conflict=id`,
    method: "POST",
    headers: headers(settings, { Prefer: "resolution=merge-duplicates,return=minimal" }),
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
  throwOnError(res, `upsert ${payload.path}`);
}

/** Page through every row with mtime > sinceMs, ordered so pagination is stable even when many rows share an mtime. */
export async function scrollChangedSince(settings: PostgrestSettings, sinceMs: number): Promise<NoteRow[]> {
  const rows: NoteRow[] = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await requestUrl({
      url: `${settings.postgrestUrl}/notes?mtime=gt.${sinceMs}&order=mtime.asc,id.asc&limit=${limit}&offset=${offset}&select=id,path,content,content_hash,mtime,size,deleted`,
      method: "GET",
      headers: headers(settings),
      throw: false,
    });
    throwOnError(res, "scroll changed-since");
    const page = res.json as NoteRowJson[];
    rows.push(...page.map(rowToNoteRow));
    if (page.length < limit) break;
    offset += limit;
  }
  return rows;
}

export async function getNoteByPath(settings: PostgrestSettings, path: string): Promise<NoteRow | undefined> {
  const res = await requestUrl({
    url: `${settings.postgrestUrl}/notes?path=eq.${encodeURIComponent(path)}&limit=1&select=id,path,content,content_hash,mtime,size,deleted`,
    method: "GET",
    headers: headers(settings),
    throw: false,
  });
  throwOnError(res, `lookup ${path}`);
  const rows = res.json as NoteRowJson[];
  return rows[0] ? rowToNoteRow(rows[0]) : undefined;
}
