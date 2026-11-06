import { execFile, execFileSync } from "node:child_process";
import { markCommentsNotified, readComments, type Comment } from "./comments.js";
import { feedEntryRevisions, readFeedEntries } from "./feed.js";

/**
 * How to reach the agent that submitted a revision. Herdr is the only kind so
 * far, and an optional one: without it there is no origin, and comments reach
 * the agent through `submit` and `artifacts comments` instead.
 */
export interface AgentOrigin {
  kind: "herdr";
  paneId: string;
  /** A pane can outlive its agent; this is what proves it is still the same one. */
  sessionId: string;
  socket?: string;
}

const HERDR_TIMEOUT_MS = 5_000;
/** An agent that hasn't come back in a day isn't coming back; stop polling for it. */
const MAX_NOTIFY_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_PANE = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function herdrEnv(socket: string | undefined): NodeJS.ProcessEnv {
  return socket ? { ...process.env, HERDR_SOCKET_PATH: socket } : process.env;
}

function sessionIn(stdout: string): string | undefined {
  const parsed = JSON.parse(stdout) as { result?: { agent?: { agent_session?: { value?: unknown } } } };
  const value = parsed.result?.agent?.agent_session?.value;
  return typeof value === "string" && value ? value : undefined;
}

/** Best effort: a submit must never fail or stall because Herdr is unhappy. */
export function captureOrigin(): AgentOrigin | undefined {
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId || !SAFE_PANE.test(paneId)) return undefined;
  const socket = process.env.HERDR_SOCKET_PATH || undefined;
  try {
    const stdout = execFileSync(herdrBin(), ["agent", "get", paneId], {
      encoding: "utf8",
      timeout: HERDR_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      env: herdrEnv(socket),
    });
    const sessionId = sessionIn(stdout);
    return sessionId ? { kind: "herdr", paneId, sessionId, ...(socket ? { socket } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function runHerdr(origin: AgentOrigin, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; code?: string }> {
  return new Promise((resolve) => {
    execFile(
      herdrBin(),
      args,
      { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, env: herdrEnv(origin.socket) },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        try {
          resolve({ ok: false, code: (JSON.parse(stderr) as { error?: { code?: string } }).error?.code });
        } catch {
          resolve({ ok: false });
        }
      },
    );
  });
}

/**
 * Only a fixed pointer goes into the terminal, never the comment. Whatever the
 * user wrote should reach the agent as data it read, not as a prompt typed for
 * it; `slug` and `projectId` are checked because the feed is a hand-editable file.
 */
export function notificationText(projectId: string, slug: string): string {
  const cli = cliCommand();
  // "Read it" alone isn't enough: an agent told only that reads the comment and
  // then waits to be asked, which is the step this exists to remove.
  return `The user left a comment on your artifact "${slug}". Read it with: ${cli} comments ${slug} --project ${projectId}. Then do what it asks if that fits this artifact, check with the user first if it is destructive or out of scope, and when done run: ${cli} resolve <id>`;
}

/** The CLI this server runs from, so the command understands what it just wrote. */
function cliCommand(): string {
  const script = process.argv[1];
  const cli = script?.endsWith(".js") ? `node ${shellWord(script)}` : "npx @agentuse/artifacts";
  // The agent's shell won't have a custom store the server was started with.
  const home = process.env.AGENTUSE_ARTIFACTS_HOME;
  return home ? `AGENTUSE_ARTIFACTS_HOME=${shellWord(home)} ${cli}` : cli;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9/._-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

async function notifyOrigin(origin: AgentOrigin, text: string): Promise<boolean> {
  const current = await runHerdr(origin, ["agent", "get", origin.paneId]);
  if (!current.ok) return false;
  try {
    // Same pane, different session: the agent that made this artifact is gone.
    if (sessionIn(current.stdout) !== origin.sessionId) return false;
  } catch {
    return false;
  }
  // A blocked agent refuses this with agent_blocked, and the timer tries again.
  return (await runHerdr(origin, ["agent", "prompt", origin.paneId, text])).ok;
}

/**
 * Send one message per artifact for every comment its agent hasn't heard about.
 * Goes to whoever submitted the newest revision: that agent owns the artifact
 * now, and an older one may be on something else entirely.
 */
export async function deliverPendingComments(now = Date.now()): Promise<number> {
  const pending = readComments().filter(
    (c) => !c.resolvedAt && !c.notifiedAt && now - new Date(c.createdAt).getTime() < MAX_NOTIFY_AGE_MS,
  );
  const groups = new Map<string, Comment[]>();
  for (const comment of pending) {
    const key = `${comment.projectId}\0${comment.slug}`;
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  const entries = readFeedEntries();
  let delivered = 0;
  for (const comments of groups.values()) {
    const { projectId, slug } = comments[0]!;
    const origin = feedEntryRevisions(entries, projectId, slug)[0]?.origin;
    if (
      origin?.kind !== "herdr" ||
      !SAFE_PANE.test(origin.paneId) ||
      !SAFE_NAME.test(slug) ||
      !SAFE_NAME.test(projectId)
    ) continue;
    if (!(await notifyOrigin(origin, notificationText(projectId, slug)))) continue;
    markCommentsNotified(comments.map((c) => c.id));
    delivered += comments.length;
  }
  return delivered;
}
