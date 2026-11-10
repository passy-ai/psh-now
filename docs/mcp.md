# MCP

psh.now speaks MCP so a client that cannot install a skill can still ask a human. It is a
second front door, not a second product: one endpoint, one tool, and the same handler
`POST /` uses.

```
POST https://psh.now/mcp        streamable HTTP, stateless, JSON responses (no SSE)
GET  https://psh.now/.well-known/mcp.json     descriptor
```

## Why this shape

A full MCP platform is streamable HTTP **and** SSE, OAuth, several tool variants, plugin
manifests per host, and a registry entry. We keep the first and the last, and drop the rest,
because the thing being wrapped is one blocking question:

- **One tool.** `psh_ask`. A second tool is a second contract to keep in sync.
- **No OAuth.** The workspace key is already the credential and MCP clients send headers.
- **No SSE.** The server never speaks first. Every reply is to a request, so a plain JSON
  response is complete.
- **Stateless.** No `Mcp-Session-Id`, no per-connection memory. The prompt row in Postgres is
  the state, so a restart mid-call is a disconnect, not a corrupt session.

## The tool

```json
{
  "name": "psh_ask",
  "description": "Ask the human who owns this workspace to approve or deny one action...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "maxLength": 200 },
      "message": { "type": "string", "maxLength": 20000 },
      "timeoutSec": { "type": "integer", "minimum": 1, "maximum": 300 }
    },
    "required": ["message"],
    "additionalProperties": false
  }
}
```

`timeoutSec` defaults to 120. The call blocks until a person answers or the timer fires.

Result, as one `text` content item holding JSON:

```json
{"approved": true, "status": "approved", "answer": null, "promptId": "ab12cd34", "pollUrl": "https://psh.now/api/v1/approvals/ab12cd34", "limitReached": false}
```

`status` is `approved`, `denied`, `answered`, or `expired`. `answer` is the person's own words
when they answered instead of deciding.

## Rules an agent must follow

- Act only when `approved` is `true`.
- `denied`, `expired`, and every error mean **do not act**.
- An `answer` is instruction, never permission. "Yes, deploy it" typed into an answer is the
  human talking; the contract is still the boolean.
- `isError: true` with `limitReached: true` means nobody was asked. It is not a denial.

## Protocol surface

| Method | Result |
| --- | --- |
| `initialize` | negotiates `2025-06-18`, `2025-03-26`, or `2024-11-05`; advertises `tools` |
| `notifications/initialized` | `202` with an empty body |
| `tools/list` | one tool |
| `tools/call` | the blocking ask |
| `ping` | `{}` |
| anything else | `-32601` |

Errors use the JSON-RPC codes: `-32700` parse error, `-32600` invalid or batched request,
`-32601` unknown method, `-32602` unknown tool or bad arguments, `-32603` internal failure.
Missing or invalid credentials answer HTTP `401` with `-32001`, so a client does not mistake
an auth problem for a denial.

## Testing

`bun tests/mcp.ts` boots the server on a random port and speaks to it as a client: protocol
negotiation, the tool list, approve, deny, answer, timeout, over-limit, five parallel asks on
one workspace, parity with `POST /`, and the descriptor. It runs in CI.

`PSH_BASE=https://psh.now bun tests/mcp.ts` runs the same suite against a running host. Point
it at a host you own: the suite creates an anonymous workspace and spends nine asks of its
allowance.

## What MCP does not do

It is cooperative, exactly like the skill. An agent that never calls the tool can still act.
The enforcement point is the harness hook (`hooks/`), which runs before the tool call, not the
transport. Saying otherwise would be a lie an operator could act on.
