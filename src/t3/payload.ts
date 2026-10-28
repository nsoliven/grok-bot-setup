import type { Notice } from "./policy";
import type { WaitingStatus } from "./state";

/**
 * Webhook bodies sent to the assistant. Metadata only: no message text, no question text,
 * no file paths. The assistant reads content through the gateway when it needs it.
 */

export const PAYLOAD_SCHEMA = 1;

export interface PayloadOptions {
  includeTitles: boolean;
  /** Optional base URL for a tap-to-open link, e.g. your T3 address over WireGuard. */
  linkBase: string | null;
  host: string;
}

export interface NeedsYouItem {
  threadId: string;
  projectId: string;
  project: string | null;
  title: string | null;
  status: WaitingStatus;
  waitingSince: string;
  minutesWaiting: number;
  pendingRequestCount: number;
  runtimeMode: string;
  notice: "first" | "reminder";
  /** Approvals can only be decided inside T3; everything else can be answered from chat. */
  answerableFromChat: boolean;
  link: string | null;
}

export interface NeedsYouPayload {
  event: "t3.needs_you";
  schema: number;
  source: "grok-bot-setup";
  host: string;
  sentAt: string;
  lastSeenInT3At: string | null;
  items: NeedsYouItem[];
  alsoWaiting: number;
}

export interface MaintenancePayload {
  event: "t3.watcher_problem" | "t3.gateway_credential_expiring" | "t3.test";
  schema: number;
  source: "grok-bot-setup";
  host: string;
  sentAt: string;
  detail: string;
  expiresAt?: string;
}

export function buildNeedsYouPayload(
  notices: Notice[],
  alsoWaiting: number,
  lastSeenInT3At: string | null,
  now: Date,
  options: PayloadOptions,
): NeedsYouPayload {
  return {
    event: "t3.needs_you",
    schema: PAYLOAD_SCHEMA,
    source: "grok-bot-setup",
    host: options.host,
    sentAt: now.toISOString(),
    lastSeenInT3At,
    alsoWaiting,
    items: notices.map(({ item, notice }) => ({
      threadId: item.threadId,
      projectId: item.projectId,
      project: options.includeTitles ? item.project : null,
      title: options.includeTitles ? item.title : null,
      status: item.status,
      waitingSince: item.waitingSince,
      minutesWaiting: Math.floor((now.getTime() - Date.parse(item.waitingSince)) / 60_000),
      pendingRequestCount: item.pendingRequestIds.length,
      runtimeMode: item.runtimeMode,
      notice,
      answerableFromChat: item.status !== "needs_approval",
      link: options.linkBase ? `${options.linkBase.replace(/\/+$/, "")}/${encodeURIComponent(item.threadId)}` : null,
    })),
  };
}

export function buildMaintenancePayload(
  event: MaintenancePayload["event"],
  detail: string,
  now: Date,
  host: string,
  expiresAt?: string,
): MaintenancePayload {
  return {
    event,
    schema: PAYLOAD_SCHEMA,
    source: "grok-bot-setup",
    host,
    sentAt: now.toISOString(),
    detail,
    ...(expiresAt ? { expiresAt } : {}),
  };
}
