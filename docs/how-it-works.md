# How it works

## What counts as "waiting on you"

The watcher's reader, [`src/t3/state.ts`](../src/t3/state.ts). It opens T3's `statev2.sqlite` read-only and follows T3's own awareness rules (`projectThreadAwarenessV2` in T3's source):

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

There are no "resolved" events: they would wake the assistant for nothing. If it needs to know whether something is still waiting, it asks T3 over MCP.

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

At most one per kind per day. The body has `event`, `schema`, `source`, `host`, `sentAt` and `detail`.

| `event` | Meaning |
|---|---|
| `t3.watcher_problem` | The watcher cannot read T3's state, usually after a T3 update changed its tables. Alerts are off until fixed. |
| `t3.test` | Sent by `grok-t3 test-webhook`. |

## Answering: T3's own MCP through your tunnel

The assistant connects to T3's `/mcp` as an outside agent, as T3's `docs/user/outside-agents.md` describes for hosted agents. The only difference is the route: your Cloudflare Tunnel instead of T3 Connect.

T3 builds its OAuth URLs from the request's `Host` and `X-Forwarded-Proto`. cloudflared passes the public hostname and Cloudflare sets `https`, so T3 advertises `https://<your hostname>` as the issuer without any T3 setting.

### What the tunnel lets through

| Path | Called by | Access login? |
|---|---|---|
| `/mcp` | The assistant's servers, with T3's bearer token | Bypassed |
| `/.well-known/oauth-protected-resource`, `…/mcp`, `/.well-known/oauth-authorization-server` | The assistant's servers, to discover the sign-in | Bypassed |
| `/oauth/mcp/register`, `/oauth/mcp/token` | The assistant's servers: client registration, code exchange | Bypassed |
| `/oauth/mcp/authorize`, `/oauth/mcp/approval`, `/oauth/mcp/decision` | Your browser, approving the sign-in | Required |
| `/connect-agent`, `/assets/*`, icons and manifest | Your browser: T3's approval page | Required |
| `/api/auth/session`, `/.well-known/t3/environment` | Your browser: two read-only calls the page makes on load | Required |
| Everything else, including `/ws` and the rest of `/api` | Nobody | 404 at the tunnel |

### Signing in

1. You add the connector with the MCP URL and OAuth. The assistant discovers T3's sign-in, registers itself, and opens T3's authorize URL in your browser.
2. Cloudflare Access asks for your email and sends a one-time PIN.
3. T3's approval page names the assistant and where the approval goes (its callback host). You enter a pairing code and pick the access level.
4. T3 redirects to the assistant's callback with a one-minute code, which the assistant exchanges for a 30-day token.

Get a pairing code in T3 under Settings → Sharing & access, or on the host:

```bash
t3 auth pairing create --ttl 10m --label "Grok Bot" \
  --scope orchestration:read --scope orchestration:operate \
  --scope settings:write --scope source-control:write
```

The last two scopes are needed only for a full-access ceiling. Use the `t3` binary of the running server (`~/.t3/runtime/versions/<version>/t3`); an older `t3` on your `PATH` may not match.

## Why the gateway is gone

Earlier versions put a four-tool gateway between the assistant and T3. It gave the assistant less power, but it had to be maintained against T3's changing tool names, and it could not do what T3's own MCP does (start threads, read any thread, work across linked machines). Now the security boundary is in front of T3 instead of beside it: the tunnel's path allowlist, Access on the browser pages, and the ceiling you choose at approval.
