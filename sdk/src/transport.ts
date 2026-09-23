/**
 * Sightline → sidecar HTTP 通讯。
 *
 * 端点约定（见 docs/architecture.md §3.3）:
 *   POST /bootstrap           → { sessionId, token, endpoint, document }
 *   POST /sessions/{id}/sync  （Authorization: Bearer <token>）
 */

import type { FeedbackDocument, SyncRequest } from "./types.generated";

interface BootstrapInput {
  endpoint: string;
}

interface BootstrapResponse {
  sessionId: string;
  token: string;
  endpoint: string;
  /** sidecar 顺便把当前文档返回（首次通常是空文档）；SDK 不依赖它非空。 */
  document: FeedbackDocument;
}

interface Session {
  endpoint: string;
  sessionId: string;
  token: string;
  document: FeedbackDocument;
}

async function postJson<T>(url: string, body: unknown, token?: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // 注意：跨域请求会触发 preflight；sidecar 已配 CORS 放行 Authorization + Content-Type。
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    mode: "cors",
    credentials: "omit",
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error ?? ""; } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export async function bootstrap(endpoint: string): Promise<BootstrapResponse> {
  // 第一次请求不带 token；sidecar 用 Origin 头判断是否 loopback。
  return postJson<BootstrapResponse>(`${endpoint}/bootstrap`, {}, undefined);
}

export async function syncFeedback(session: Session, req: SyncRequest): Promise<FeedbackDocument> {
  return postJson<FeedbackDocument>(
    `${session.endpoint}/sessions/${session.sessionId}/sync`,
    req,
    session.token,
  );
}

export type { BootstrapInput, BootstrapResponse, Session };
