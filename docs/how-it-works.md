# How it works

## What counts as "waiting on you"

The watcher and gateway share one reader, [`src/t3/state.ts`](../src/t3/state.ts). It opens T3's `statev2.sqlite` read-only and follows T3's own awareness rules (`projectThreadAwarenessV2` in T3's source):

| Status | When | Counts for alerts when |
|---|---|---|
| `needs_answer` | The latest run has a pending user-input request (an agent asked you a question) | Always, until answered |
| `needs_approval` | The latest run has a pending approval ("Allow running this command?") | Always. These can only be decided inside T3. |
| `finished` | The latest run completed | You have not opened the thread since it ended (`lastVisitedAt` < `completedAt`) |
| `failed` | The latest run failed | Same as finished |

Never counted: subagent threads, archived or deleted threads, finished threads you settled, snoozed threads (until the snooze ends), running threads, requests left over from an earlier run, and anything that started waiting more than `WATCH_WINDOW_DAYS` ago.

## When the watcher speaks up

[`src/t3/policy.ts`](../src/t3/policy.ts) works in **episodes**: one thread waiting in one way (same run, status and pending requests). A new run in the same thread is a new episode.

1. A first notice is due when an episode has waited `NOTIFY_ANSWER_AFTER_MIN` (questions and approvals, default 10) or `NOTIFY_FINISHED_AFTER_MIN` (finished and failed, default 30).
2. One reminder is due `NOTIFY_REMINDER_AFTER_MIN` after the first notice (default 180). After that the episode stays silent.
3. Everything due goes out in **one** POST, and only if the last POST was at least `NOTIFY_MIN_GAP_MIN` ago (default 20) and fewer than `NOTIFY_DAILY_CAP` went out in the last 24 hours (default 12). Otherwise it waits for the next window.
4. Episodes that started waiting more than `NOTIFY_MAX_FIRST_NOTICE_AGE_MIN` ago (default 12 hours) never get a first notice, so a restart does not dump a backlog on you.
5. `grok-t3 pause 2h` holds everything until the pause ends.

There are no "resolved" events: they would wake the assistant for nothing. If it needs to know whether something is still waiting, it calls `list_waiting`.

## Webhook payloads

Every POST carries `Authorization: <your routine's value>` and a JSON body. Fields are stable within a `schema` number.

### `t3.needs_you`

```json
{
  "event": "t3.needs_you",
  "schema": 1,
  "source": "grok-bot-setup",
  "host": "my-server",
  "sentAt": "2026-10-28T16:40:00.000Z",
  "lastSeenInT3At": "2026-10-28T15:02:11.000Z",
  "alsoWaiting": 1,
  "items": [
    {
      "threadId": "0f9c1d2e-…",
      "projectId": "7b3e5a10-…",
      "project": "api",
      "title": "Fix flaky upload test",
      "status": "needs_answer",
      "waitingSince": "2026-10-28T16:26:00.000Z",
      "minutesWaiting": 14,
      "pendingRequestCount": 1,
      "runtimeMode": "full-access",
      "notice": "first",
      "answerableFromChat": true,
      "link": null
    }
  ]
}
```

- `notice`: `first` or `reminder`.
- `alsoWaiting`: threads you were already told about that are still waiting, not repeated in `items`.
- `lastSeenInT3At`: the last time you opened any thread in T3. Lets the assistant tell whether you are at your desk.
- `project` and `title` are `null` when `PAYLOAD_INCLUDE_TITLES=0`. `link` is set only when you configure `PAYLOAD_LINK_BASE`.

### Maintenance events

At most one per kind per day. The body has `event`, `schema`, `source`, `host`, `sentAt`, `detail` and, for credential expiry, `expiresAt`.

| `event` | Meaning |
|---|---|
| `t3.watcher_problem` | The watcher cannot read T3's state, usually after a T3 update changed its tables. Alerts are off until fixed. |
| `t3.gateway_credential_expiring` | The gateway's T3 credential expires within 3 days. Run `grok-t3 pair`. |
| `t3.test` | Sent by `grok-t3 test-webhook`. |

## The gateway's tools

[`src/t3/gateway.ts`](../src/t3/gateway.ts) is a stateless Streamable HTTP MCP server on `127.0.0.1:47731/mcp`. Every request needs `Authorization: Bearer <gateway bearer>` and a valid `Cf-Access-Jwt-Assertion` that Cloudflare Access adds after checking the service token.

| Tool | Does | Refuses when |
|---|---|---|
| `list_waiting` | Every thread waiting on you, read or unread, with what to answer it with | — |
| `read_waiting_thread` | The pending question(s), via T3's `t3_pending_request_read`, and the agent's latest message, each truncated to 4,000 characters and marked untrusted | The thread is not waiting |
| `answer_question` | T3's `t3_pending_request_respond` with `answers` keyed by question id | The thread has no such pending question, read-only mode, or the daily cap |
| `reply_to_thread` | T3's `t3_thread_send` with `mode: "queue"`, so it starts the next turn and never steers or interrupts | The thread is not finished or failed, you have opened it in T3 since it ended, read-only mode, or the daily cap |

Writes run one at a time. The daily cap (`GATEWAY_DAILY_WRITE_CAP`, default 30) counts every attempt, including ones T3 refused, and JSON-RPC batch requests are rejected, so parallel or batched calls cannot get past it. Unexpected errors reach the assistant as a generic message; the details stay in the journal.

The gateway calls T3's own MCP over loopback with a credential from `grok-t3 pair`. That command mints a 10-minute single-use pairing code with the running T3's CLI and completes T3's OAuth flow (dynamic client registration, PKCE S256, pairing-code approval, code exchange) without a browser. T3 MCP grants last 30 days and cannot be refreshed, so you pair again before expiry; the watcher reminds you.

## Why not just expose T3's MCP?

- **Power.** An operate grant whose ceiling covers full-access threads can call `t3_thread_launch`, configure threads, push code, and change settings. In the cloud, that is a remote shell. The gateway only forwards three T3 calls, and only for threads waiting on you.
- **Auth fit.** T3's MCP uses OAuth, builds its URLs from the `Host` and `X-Forwarded-Proto` headers, and has no refresh tokens. Putting Cloudflare Access in front blocks OAuth discovery unless those endpoints are opened to the internet. The gateway takes static headers, which an assistant connector supports directly.
- **Privacy.** T3's MCP can read every thread. The gateway can read only threads waiting on you.
