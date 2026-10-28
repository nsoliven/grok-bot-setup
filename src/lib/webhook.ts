import { readSecret } from "./config";

export type WebhookResult = { ok: true; status: number } | { ok: false; status: number | null; reason: string };

/**
 * POSTs JSON to the assistant's routine webhook. The URL and Authorization value are secrets:
 * they are read from the secrets directory on each send and never appear in results or logs.
 */
export async function postToAssistant(body: unknown): Promise<WebhookResult> {
  const url = readSecret("grok-webhook-url");
  const authorization = readSecret("grok-webhook-authorization");
  if (!url.startsWith("https://")) return { ok: false, status: null, reason: "webhook URL must be https" };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, reason: `assistant webhook answered HTTP ${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, status: null, reason: `assistant webhook unreachable (${name})` };
  }
}
