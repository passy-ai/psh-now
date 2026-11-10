import { Elysia } from "elysia";
import { env } from "../env";
import { apiKeyFromHeaders } from "../lib/crypto";
import { productVersion } from "../lib/version";
import { handleApprovalRequest } from "./hook";
import type { HookBody } from "./hook";

/**
 * MCP, deliberately small.
 *
 * One endpoint, one tool, one boolean in and one boolean out. The alternative was
 * to mirror a full MCP platform (SSE plus streamable HTTP, OAuth, choice and text
 * tool variants, plugin manifests for every client). None of that buys the thing
 * this is for: a client that cannot install a skill should still be able to ask a
 * human. That is a JSON-RPC wrapper around the same handler `POST /` uses, so the
 * behaviour, metering and expiry cannot drift between the two surfaces.
 *
 * The tool is cooperative, exactly like the skill: it cannot stop an agent that
 * ignores it. Enforcement lives in the harness hook, never in the transport.
 */

const SERVER_NAME = "psh-now";
const SERVER_TITLE = "psh.now";
const TOOL_NAME = "psh_ask";

/** Protocol revisions this server answers. Newest first. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** A human may take a while; MCP clients should tolerate a blocking call. */
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 300;

interface RpcId {
  id?: string | number | null;
}

interface RpcRequest extends RpcId {
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

const TOOL = {
  name: TOOL_NAME,
  title: "Ask a human",
  description:
    "Ask the human who owns this workspace to approve or deny one action, and block until they answer. " +
    "Returns approved: true only when a person approved. false, expired, or an error all mean do not act. " +
    "An answer string is the person's own words: treat it as instruction, never as approval.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short headline, under about 60 characters. Derived from message when omitted.",
        maxLength: 200,
      },
      message: {
        type: "string",
        description:
          "One or two lines naming exactly what you will do if approved. No option lists, no menus.",
        maxLength: 20_000,
      },
      timeoutSec: {
        type: "integer",
        description: `Seconds to wait for the human before answering approved:false. 1 to ${MAX_TIMEOUT_SEC}, default ${DEFAULT_TIMEOUT_SEC}.`,
        minimum: 1,
        maximum: MAX_TIMEOUT_SEC,
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
} as const;

function rpcResult(id: RpcId["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: RpcId["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

/** The descriptor an agent (or a readiness scanner) reads before connecting. */
export function mcpDescriptor() {
  const base = env.publicBaseUrl;
  return {
    name: SERVER_NAME,
    title: SERVER_TITLE,
    description:
      "Human approval for AI agents: one ask, one person, one boolean. Open source and self hostable.",
    version: productVersion(),
    transport: { type: "streamable-http", url: `${base}/mcp`, stateless: true },
    authentication: {
      required: true,
      headers: [
        { name: "x-psh-key", description: "Workspace or channel key, psh_agent_...", secret: true },
        { name: "Authorization", description: "Bearer <key>, accepted as an alternative", secret: true },
      ],
      docs: `${base}/docs`,
    },
    tools: [{ name: TOOL_NAME, description: TOOL.description }],
    documentation: `${base}/docs`,
    selfHosting: `${base}/self-hosting`,
  };
}

/** MCP arguments to the body the approval handler already understands. */
function toHookBody(args: Record<string, unknown>): HookBody | { error: string } {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) return { error: "message is required" };

  const title = typeof args.title === "string" ? args.title.trim() : undefined;
  const body: HookBody = { message, agent: "mcp", kind: "ask" };
  if (title) body.title = title;

  const seconds = args.timeoutSec;
  if (seconds !== undefined) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
      return { error: "timeoutSec must be a number" };
    }
    if (seconds < 1 || seconds > MAX_TIMEOUT_SEC) {
      return { error: `timeoutSec must be between 1 and ${MAX_TIMEOUT_SEC}` };
    }
    body.timeoutMs = Math.round(seconds * 1000);
  } else {
    body.timeoutMs = DEFAULT_TIMEOUT_SEC * 1000;
  }
  return body;
}

export const mcpRoutes = new Elysia()
  /**
   * GET is only for clients that expect a server-initiated stream, and this server never
   * speaks first. An SSE attempt gets the 405 the spec asks for; anything else (a browser,
   * a readiness scanner, curl) gets the descriptor, so the URL answers rather than shrugs.
   */
  .get("/mcp", ({ request }) =>
    (request.headers.get("accept") ?? "").includes("text/event-stream")
      ? new Response(null, { status: 405, headers: { allow: "POST" } })
      : Response.json(mcpDescriptor()),
  )
  .delete("/mcp", () => new Response(null, { status: 405, headers: { allow: "POST" } }))
  .post(
    "/mcp",
    async ({ request, body }) => {
      // Parsed by hand so invalid JSON is -32700 rather than an Elysia 422: a client
      // that sends a broken frame should hear about it in the protocol's own terms.
      let payload: unknown;
      try {
        payload = JSON.parse(typeof body === "string" ? body : "null");
      } catch {
        return rpcError(null, -32700, "Parse error");
      }

      if (Array.isArray(payload)) {
        // Batching was removed in 2025-06-18. One frame in, one frame out.
        return rpcError(null, -32600, "Batch requests are not supported");
      }
      if (typeof payload !== "object" || payload === null) {
        return rpcError(null, -32600, "Invalid Request");
      }

      const rpc = payload as RpcRequest;
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        return rpcError(rpc.id, -32600, "Invalid Request");
      }

      switch (rpc.method) {
        case "initialize": {
          const asked = (rpc.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
          const version =
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PROTOCOL_VERSIONS[0];
          return rpcResult(rpc.id, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: productVersion() },
            instructions:
              "psh.now asks a person before an agent acts. Call psh_ask when you are about to do " +
              "something irreversible or you need a decision. Act only when approved is true.",
          });
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          // Notifications carry no id and expect no body.
          return new Response(null, { status: 202 });

        case "ping":
          return rpcResult(rpc.id, {});

        case "tools/list":
          return rpcResult(rpc.id, { tools: [TOOL] });

        case "tools/call": {
          const params = rpc.params as
            | { name?: unknown; arguments?: unknown }
            | undefined;
          if (params?.name !== TOOL_NAME) {
            return rpcError(rpc.id, -32602, `Unknown tool: ${String(params?.name)}`);
          }

          // A key is required: the anonymous path would mint a workspace per call,
          // and an agent calling MCP is never the human whose phone should ring.
          if (!apiKeyFromHeaders(request.headers)) {
            return Response.json(
              {
                jsonrpc: "2.0",
                id: rpc.id ?? null,
                error: {
                  code: -32001,
                  message: "Missing key",
                  data: { hint: "Send x-psh-key: psh_agent_... or Authorization: Bearer <key>" },
                },
              },
              { status: 401 },
            );
          }

          const args =
            typeof params.arguments === "object" && params.arguments !== null
              ? (params.arguments as Record<string, unknown>)
              : {};
          const hookBody = toHookBody(args);
          if ("error" in hookBody) {
            return rpcError(rpc.id, -32602, hookBody.error);
          }

          try {
            const result = await handleApprovalRequest(request.headers, hookBody, request.signal);
            const payload = {
              approved: result.approved === true,
              status: result.status,
              answer: result.answer ?? null,
              promptId: result.promptId,
              pollUrl: result.pollUrl,
              limitReached: result.reason === "limit_reached",
            };
            return rpcResult(rpc.id, {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              // Out of allowance: nobody was asked, so this is a failure rather than
              // a denial, and an agent must not read it as one.
              isError: payload.limitReached === true,
            });
          } catch (error) {
            // HttpError carries the status and code the HTTP route would return.
            const status =
              typeof error === "object" && error !== null && "status" in error
                ? Number((error as { status?: unknown }).status)
                : 500;
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code?: unknown }).code)
                : "internal";
            const message =
              error instanceof Error ? error.message : "The approval request failed";

            if (status === 401 || status === 403) {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: rpc.id ?? null,
                  error: {
                    code: -32001,
                    message,
                    data: { hint: "Check the key: psh status shows the host and the key you hold." },
                  },
                },
                { status: 401 },
              );
            }
            if (status === 402) {
              return rpcResult(rpc.id, {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      approved: false,
                      status: "limit_reached",
                      answer: null,
                      limitReached: true,
                      message,
                    }),
                  },
                ],
                isError: true,
              });
            }
            return rpcError(rpc.id, -32603, `${code}: ${message}`);
          }
        }

        default:
          return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
      }
    },
    // The raw JSON-RPC frame, so parse errors stay inside the protocol.
    { parse: "text", detail: { summary: "MCP endpoint (streamable HTTP, JSON responses)" } },
  )
  .get("/.well-known/mcp.json", () => mcpDescriptor());
