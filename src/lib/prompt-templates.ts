import { env } from "../env";

/**
 * The three canonical prompts, in one place.
 *
 * Each is ONE copyable code block, with the install and the setup merged into a
 * single command, and no PSH_* environment variable in the text a human pastes.
 * The canonical literal lives in `docs/prompt-templates.md`; the strings here
 * must match it (and each other) character for character:
 *
 *   1. fresh install        - nothing to join yet
 *   2. join a channel       - the agent is already installed
 *   3. install and join     - a new sandbox, which must join as it installs
 */

/**
 * The host the prompts name: this instance's own public URL, not ours. A self hosted
 * instance that hands out `psh.now` in a prompt sends installers to the wrong server, so
 * `PUBLIC_BASE_URL` wins and the public host is only the fallback.
 */
export const PROMPT_HOST = (env.publicBaseUrl || "https://psh.now").replace(/\/$/, "");

/** The `<channel-id>` token the pages interpolate with a real channel URL. */
export const CHANNEL_ID_PLACEHOLDER = "<channel-id>";

/**
 * #1 - fresh install, no channel link. The homepage's copy button and the first
 * snippet on the docs page.
 */
export function installPrompt(): string {
  return `I'd like you to set up psh.now: Install as a skill with npx skills add passy-ai/psh-now-skill -g -y

If not, download the installer first and read it before running it:
curl -fsSL ${PROMPT_HOST}/install.sh

After installing, send me a test request.`;
}

/**
 * #2 - the agent is already installed; join one channel. `channelUrl` is the
 * channel's `/c/<id>` link, the `CHANNEL_ID_PLACEHOLDER` in the template.
 */
export function joinPrompt(channelUrl: string): string {
  const url = channelUrl || `${PROMPT_HOST}/c/${CHANNEL_ID_PLACEHOLDER}`;
  return `I'd like you to use psh.now and join ${url}.`;
}

/**
 * #3 - a new sandbox with nothing installed, which must join while it installs.
 * Docs only: the channel pages hand out #2, because re-running an installer on a machine
 * that only needed to join is what mints a second account.
 * The channel URL is passed to both the skill route and the curl fallback, so
 * neither one mints a second account.
 */
export function sandboxPrompt(channelUrl: string): string {
  const url = channelUrl || `${PROMPT_HOST}/c/${CHANNEL_ID_PLACEHOLDER}`;
  return `I'd like you to set up psh.now: Install as a skill with npx skills add passy-ai/psh-now-skill -g -y
and join ${url}

If not, download the installer first and read it before running it:
curl -fsSL ${PROMPT_HOST}/install.sh`;
}
