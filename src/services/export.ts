import { csvText } from "../lib/csv";
import { getPlan, historyCutoff } from "../lib/plans";
import { listChannelHistory } from "./prompts";
import { serializePrompt } from "../routes/hook";
import { approverOf, getTenant } from "./tenants";
import type { Session } from "../db/schema";

/**
 * The CSV a channel's Export produces, built once on the server.
 *
 * Columns are the ones the dashboard has always written, in the same order, so a
 * file someone already has in a spreadsheet still lines up with a new one.
 */

const COLUMNS: Array<[string, string]> = [
  ["createdAt", "Requested"],
  ["title", "Request"],
  ["message", "Details"],
  ["status", "Status"],
  ["answer", "Answer"],
  ["decision", "Decision"],
  ["agentId", "Agent"],
  ["decidedBy", "Decided by"],
  ["decidedAt", "Decided at"],
];

export interface ChannelExport {
  filename: string;
  csv: string;
  /** Data rows written, so the caller can say "nothing decided yet" instead of shipping headers only. */
  count: number;
}

/** `psh-<channel>-<date>.csv`, with the channel reduced to a safe filename. */
function filenameFor(name: string, now = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "channel";
  return `psh-${slug}-${now.toISOString().slice(0, 10)}.csv`;
}

/** The data rows: everything decided in the channel, inside the plan's window. */
async function channelRows(channel: Session, viewerId: string): Promise<unknown[][]> {
  const viewer = await getTenant(viewerId);
  const items = await listChannelHistory(channel.tenantId, channel.id, {
    // The same window the dashboard shows: a plan buys the history it buys.
    since: historyCutoff(getPlan(viewer?.plan)),
  });

  // The channel owner is who approves, not whoever pressed Export on a shared channel.
  const owner = await getTenant(channel.tenantId);
  const approver = owner ? approverOf(owner) : null;

  return items
    .filter((p) => p.status !== "pending")
    .map((p) => {
      const prompt = serializePrompt(p);
      return COLUMNS.map(([key]) => {
        if (key === "decidedBy") return approver;
        const value = prompt[key as keyof typeof prompt];
        return key.endsWith("At") && value ? new Date(value as string).toISOString() : value;
      });
    });
}

/** How many rows the file would hold, so the dashboard can say "nothing yet". */
export async function countChannelExport(channel: Session, viewerId: string): Promise<number> {
  return (await channelRows(channel, viewerId)).length;
}

export async function buildChannelExport(
  channel: Session,
  viewerId: string,
): Promise<ChannelExport> {
  const rows = await channelRows(channel, viewerId);
  return {
    filename: filenameFor(channel.name),
    csv: csvText([COLUMNS.map(([, head]) => head), ...rows]),
    count: rows.length,
  };
}
