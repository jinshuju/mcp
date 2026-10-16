/**
 * PostHog MCP analytics (@posthog/mcp): the HTTP deployment reports how the tools are used. stdio runs on the user's
 * own machine and reports nothing.
 *
 * What is captured matches goldendata's built-in MCP (TrackMCPEventService):
 * - only $mcp_initialize and $mcp_tool_call; tools/list, resources/*, $identify and $exception are all dropped;
 * - a tool call records only argument names ($mcp_input_keys), never argument values or the result; a failure records
 *   its category and the truncated error;
 * - intent: every tool gets a context argument where the model says what the user wants to do ($mcp_intent). The SDK
 *   scrubs emails / phone numbers / IPs / card numbers from it before sending; JINSHUJU_MCP_COLLECT_INTENT=false turns
 *   it off entirely (the argument is no longer offered and nothing is reported);
 * - distinct_id = the Jinshuju user id (from GET /me); $session_id is derived from the token hash: one session per token;
 * - a session's initialize is reported at most once a day (deduplicated in process; best effort across Workers instances).
 *
 * Every other SDK injection stays off: no llm_model / conversation_id arguments, no get_more_tools / send_feedback tools.
 *
 * The PostHog client is created per request and shut down when the request ends, never shared across requests:
 * posthog-node chains each flush onto the previous one, and in Workers a flush still pending when its request's context
 * ends never settles. A shared client would hang every later request's reporting on that chain (the runtime reports
 * "code had hung" and not a single event goes out).
 */
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { deriveSessionIdFromMCPSession, instrument, type BeforeSendFn } from '@posthog/mcp';
import { PostHog, type PostHogOptions } from 'posthog-node';
import { sha256, userIdOf } from './auth.js';
import type { Config } from './config.js';
import { TOOLS } from './tools.js';
import { CONTEXT_ARGUMENT } from './validation.js';

/** Asks the model the same question as goldendata's built-in MCP, so $mcp_intent is comparable across the two. */
export const CONTEXT_DESCRIPTION = "Why are you calling this tool? Briefly describe the user's goal.";
export const CONTEXT_INSTRUCTIONS =
  `Every tool takes a \`${CONTEXT_ARGUMENT}\` argument: say what the user is actually trying to get done, ` +
  'in their own words, rather than restating what the tool does — it is what tells us which needs these tools ' +
  'are being asked to serve. Leave personal details (phone numbers, ID numbers, addresses) out of it.';

const KEPT_EVENTS = new Set(['$mcp_initialize', '$mcp_tool_call']);
/** By default the SDK attaches the (scrubbed) arguments and result; only argument names are recorded, so these go entirely. */
const DROPPED_PROPERTIES = ['$mcp_parameters', '$mcp_response', '$mcp_tool_description'];
const HANDSHAKE_TTL_MS = 24 * 60 * 60_000;
const HANDSHAKE_MAX_ENTRIES = 2000;
/** Time limit for sending the buffered events when a request ends: covers one request plus one retry */
const SHUTDOWN_TIMEOUT_MS = 15_000;
/**
 * $mcp_input_keys records only argument names declared in openapi: the SDK cannot read the declarations fromJsonSchema
 * produces, so it gets the full set here (every tool's argument names together, plus get_schema's name). Key names the
 * model makes up are all recorded as [redacted].
 */
const DECLARED_PARAMETER_NAMES = new Set<string>([
  'name',
  ...TOOLS.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {}))
]);

export interface AnalyticsOptions {
  /** PostHog project token (phc_…) */
  apiKey: string;
  /** PostHog ingest host */
  host: string;
  /** Whether to offer the context argument and report $mcp_intent; on by default */
  collectIntent?: boolean;
  /** For tests: the fetch used for reporting */
  fetch?: typeof fetch;
  now?: () => number;
  /** Timeout of one request to PostHog (ms), 5 seconds by default; for tests */
  requestTimeoutMs?: number;
}

/** The analytics handle of one request. */
export interface RequestAnalytics {
  /** Sends the events this request buffered and closes the client. On Workers it goes into waitUntil; on Node there is no need to wait. */
  flush(): Promise<void>;
}

/** Forwards the SDK's internal log to console only when something is wrong; drops the "Successfully set up…" every request prints. */
function warn(message: string): void {
  if (/^(Warning|Error|WARN)\b/.test(message)) console.warn(`[posthog-mcp] ${message}`);
}

export class McpAnalytics {
  readonly collectIntent: boolean;
  private readonly options: AnalyticsOptions;
  private readonly handshakes = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(options: AnalyticsOptions) {
    this.options = options;
    this.collectIntent = options.collectIntent ?? true;
    this.now = options.now ?? Date.now;
  }

  /** Instruments this request's McpServer: the user, the session and the PostHog client are all closed over in this one request. */
  async instrument(server: McpServer, authInfo?: AuthInfo): Promise<RequestAnalytics> {
    const sessionId = authInfo ? deriveSessionIdFromMCPSession(await sha256(authInfo.token)) : undefined;
    const distinctId = userIdOf(authInfo);
    const posthogOptions: PostHogOptions & { fetch?: unknown } = {
      host: this.options.host,
      // Events are sent from the server, so the IP is this service's; GeoIP on it would set the user's location to the data center.
      disableGeoip: true,
      // One batch per request; a failed send is retried at most once, so it does not outlast the waitUntil limit.
      requestTimeout: this.options.requestTimeoutMs ?? 5_000,
      fetchRetryCount: 1,
      fetchRetryDelay: 1_000,
      fetch: this.options.fetch
    };
    const posthog = new PostHog(this.options.apiKey, posthogOptions);
    // posthog-node logs a failed send only in debug mode; record it and throw it to the caller on flush (console + Sentry).
    const failures: unknown[] = [];
    posthog.on('error', (error: unknown) => failures.push(error));
    instrument(server, posthog, {
      context: this.collectIntent ? { description: CONTEXT_DESCRIPTION } : false,
      captureModel: false,
      enableConversationId: false,
      enableExceptionAutocapture: false,
      identify: distinctId ? { distinctId } : null,
      eventProperties: () => ({ mcp_caller_type: 'external' }),
      shouldRecordInputKey: (key, { declared }) => declared || DECLARED_PARAMETER_NAMES.has(key),
      beforeSend: this.beforeSend(sessionId),
      logger: warn
    });
    return {
      flush: () =>
        this.track(
          posthog.shutdown(SHUTDOWN_TIMEOUT_MS).then(() => {
            if (failures.length) throw failures[0];
          })
        )
    };
  }

  private track(flush: Promise<void>): Promise<void> {
    const tracked: Promise<void> = flush.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    return tracked;
  }

  private beforeSend(sessionId: string | undefined): BeforeSendFn {
    return (event) => {
      if (!KEPT_EVENTS.has(event.event)) return null;
      const props = event.properties;
      for (const key of DROPPED_PROPERTIES) delete props[key];
      if (sessionId) {
        // The SDK opens a new session per request; replace it with the token-derived one. When no user was identified, distinct_id is the session id, so replace that too.
        if (event.distinct_id === props.$session_id) event.distinct_id = sessionId;
        props.$session_id = sessionId;
      }
      if (event.event === '$mcp_initialize' && this.repeatedHandshake(String(props.$session_id ?? ''))) return null;
      return event;
    };
  }

  /** Clients handshake again and again on one connection, and every later handshake reports what the first one already did. */
  private repeatedHandshake(sessionId: string): boolean {
    if (!sessionId) return false;
    const now = this.now();
    const until = this.handshakes.get(sessionId);
    if (until !== undefined && until > now) return true;
    this.handshakes.delete(sessionId);
    if (this.handshakes.size >= HANDSHAKE_MAX_ENTRIES) {
      const oldest = this.handshakes.keys().next().value;
      if (oldest !== undefined) this.handshakes.delete(oldest);
    }
    this.handshakes.set(sessionId, now + HANDSHAKE_TTL_MS);
    return false;
  }

  /** Waits until every request's reporting still in flight has been sent: used before the Node process exits, and in tests. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.inflight);
  }

  /** Called before the process exits: same as flush. */
  shutdown(): Promise<void> {
    return this.flush();
  }
}

/** Reports only when POSTHOG_API_KEY is set. */
export function analyticsFromConfig(cfg: Config, fetchImpl?: typeof fetch): McpAnalytics | undefined {
  if (!cfg.posthogApiKey) return undefined;
  return new McpAnalytics({
    apiKey: cfg.posthogApiKey,
    host: cfg.posthogHost,
    collectIntent: cfg.collectIntent,
    fetch: fetchImpl
  });
}
