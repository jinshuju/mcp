/**
 * PostHog MCP analytics (@posthog/mcp): the HTTP deployment reports how the tools are used. stdio runs on the user's
 * own machine and reports nothing.
 *
 * What is captured:
 * - only $mcp_initialize and $mcp_tool_call; tools/list, resources/*, $identify and $exception are all dropped;
 * - a tool call records only argument names ($mcp_input_keys), never argument values or the result; a failure records
 *   the truncated error text, its bucket ($mcp_error_type: validation / permission / timeout / rate_limited / api_4xx /
 *   api_5xx / internal, read off the text because the SDK types only thrown exceptions and our tools return isError
 *   results) and, for an API failure, the HTTP status ($mcp_error_status);
 * - mcp_caller_type tells Jiri's remaining in-house path (client name mcp, python-httpx user agent) from everyone else (external);
 * - intent: every tool gets a context argument where the model says what the user wants to do ($mcp_intent). The SDK
 *   scrubs emails / phone numbers / IPs / card numbers from it before sending; JINSHUJU_MCP_COLLECT_INTENT=false turns
 *   it off entirely (the argument is no longer offered and nothing is reported);
 * - every event is anonymous ($process_person_profile: false): nothing creates or updates a person profile, and the
 *   events are billed as anonymous ones. distinct_id = `mcp:` + the Jinshuju user id (from GET /me, or the token info
 *   when the token lacks the users scope; see auth.ts), or the session id when no user was identified;
 * - $session_id is derived from the token hash: one session per token;
 * - a user's initialize is reported at most once a day per client (Asia/Shanghai days), whichever token or instance
 *   it arrives on: OAuth tokens rotate every couple of hours and a platform spreads requests over many isolates, so the
 *   mark lives in the shared KV the Workers entry passes as well as in memory (without it, each instance on its own).
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
import { sha256, userIdOf, type SharedTokenCache } from './auth.js';
import type { Config } from './config.js';
import { FORBIDDEN_HINT } from './result.js';
import { TOOLS } from './tools.js';
import { CONTEXT_ARGUMENT } from './validation.js';

/** The question the model answers in the context argument; it becomes $mcp_intent. */
export const CONTEXT_DESCRIPTION = "Why are you calling this tool? Briefly describe the user's goal.";
export const CONTEXT_INSTRUCTIONS =
  `Every tool takes a \`${CONTEXT_ARGUMENT}\` argument: say what the user is actually trying to get done, ` +
  'in their own words, rather than restating what the tool does — it is what tells us which needs these tools ' +
  'are being asked to serve. Leave personal details (phone numbers, ID numbers, addresses) out of it.';

const KEPT_EVENTS = new Set(['$mcp_initialize', '$mcp_tool_call']);
/**
 * Goes before the user id in distinct_id. PostHog counts an event as identified whenever its distinct id already belongs
 * to a person, whatever $process_person_profile says, and the bare user id may belong to one. The prefixed id is still
 * one id per user, and never a person's.
 */
const DISTINCT_ID_PREFIX = 'mcp:';
/** By default the SDK attaches the (scrubbed) arguments and result; only argument names are recorded, so these go entirely. */
const DROPPED_PROPERTIES = ['$mcp_parameters', '$mcp_response', '$mcp_tool_description'];
/** Key prefix of a day's handshake mark in the shared store, followed by the SHA-256 of user, client and day. */
const HANDSHAKE_KEY_PREFIX = 'mcp-handshake:';
/** The day is in the key, so a mark only has to outlive what is left of it. */
const HANDSHAKE_TTL_S = 24 * 60 * 60;
const HANDSHAKE_MAX_ENTRIES = 2000;
/** Days follow the PostHog project's time zone, Asia/Shanghai: UTC+8 all year round. */
const DAY_OFFSET_MS = 8 * 60 * 60_000;
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

/** The buckets PostHog's own MCP analytics uses for $mcp_error_type, so its dashboards read our events directly. */
export type ErrorType = 'validation' | 'permission' | 'timeout' | 'rate_limited' | 'api_4xx' | 'api_5xx' | 'internal';

/**
 * An argument problem caught before any request goes out: the MCP SDK's prefix on a validation.ts failure, get_schema's
 * unknown name, a composite tool given nothing to send, a path parameter left empty; and validation.ts's own phrasings,
 * should the SDK ever stop prefixing them.
 */
const VALIDATION_ERROR =
  /^(Input validation error|No schema named|Nothing to change|Missing path parameter|Unknown arguments)\b|Instance type|required property/;

/**
 * Buckets a failed tool call by its text, whose shapes are all ours: result.ts opens an API failure with `HTTP <status>:`
 * and closes it with a hint, api.ts opens a TransportError with the reason, and the MCP SDK prefixes a validation failure.
 * Anything else is an exception a tool threw, which is a bug of ours.
 */
export function classifyError(message: string): { type: ErrorType; status?: number } {
  const http = /^HTTP (\d{3}):/.exec(message);
  if (http) {
    const status = Number(http[1]);
    if (status === 429) return { type: 'rate_limited', status };
    if (status === 403 && /\bscope\b/i.test(serverErrorLines(message))) return { type: 'permission', status };
    return { type: status >= 500 ? 'api_5xx' : 'api_4xx', status };
  }
  if (VALIDATION_ERROR.test(message)) return { type: 'validation' };
  if (/^Request timed out\b/.test(message)) return { type: 'timeout' };
  return { type: 'internal' };
}

/** What the API itself said: the lines between result.ts's `HTTP <status>:` line and its hint (the 403 hint mentions scope itself). */
function serverErrorLines(message: string): string {
  return message
    .split('\n')
    .slice(1)
    .filter((line) => line !== FORBIDDEN_HINT && !line.startsWith('⚠'))
    .join('\n');
}

/**
 * Who is calling: `jiri` for the in-house assistant's remaining path through this server, which runs on the Python MCP
 * SDK's defaults (client name mcp, python-httpx user agent) and nothing else does; `external` for everyone else. The
 * retired built-in server reported the same two values.
 */
export function callerTypeOf(clientName: unknown, userAgent: unknown): 'jiri' | 'external' {
  return clientName === 'mcp' && typeof userAgent === 'string' && userAgent.startsWith('python-httpx/')
    ? 'jiri'
    : 'external';
}

export interface AnalyticsOptions {
  /** PostHog project token (phc_…) */
  apiKey: string;
  /** PostHog ingest host */
  host: string;
  /** Whether to offer the context argument and report $mcp_intent; on by default */
  collectIntent?: boolean;
  /**
   * A store every instance shares (the Workers entry passes its KV binding) for the day's handshake marks. Omitted,
   * each instance deduplicates handshakes only in its own memory.
   */
  shared?: Pick<SharedTokenCache, 'get' | 'put'>;
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
  /** This instance's handshake marks, oldest first; each key carries its day, so none has to expire. */
  private readonly handshakes = new Set<string>();
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
    const userId = userIdOf(authInfo);
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
      // Given an identity the SDK processes a person profile for it; beforeSend names the user instead.
      identify: null,
      shouldRecordInputKey: (key, { declared }) => declared || DECLARED_PARAMETER_NAMES.has(key),
      beforeSend: this.beforeSend(sessionId, userId, posthog),
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

  private beforeSend(sessionId: string | undefined, userId: string | undefined, posthog: PostHog): BeforeSendFn {
    const distinctId = userId ? DISTINCT_ID_PREFIX + userId : sessionId;
    return (event) => {
      if (!KEPT_EVENTS.has(event.event)) return null;
      const props = event.properties;
      for (const key of DROPPED_PROPERTIES) delete props[key];
      // The SDK opens a new session per request and, given no identity, uses it as the distinct id too; replace both.
      if (sessionId) props.$session_id = sessionId;
      if (distinctId) event.distinct_id = distinctId;
      // The SDK sets this itself when it is given no identity; what every event costs depends on it, so it is said here too.
      props.$process_person_profile = false;
      if (event.event === '$mcp_tool_call' && props.$mcp_is_error === true) {
        // The SDK types a thrown exception by its class; an isError result is always "Error", so the bucket comes from the text.
        const { type, status } = classifyError(String(props.$mcp_error_message ?? ''));
        props.$mcp_error_type = type;
        if (status !== undefined) props.$mcp_error_status = status;
      }
      props.mcp_caller_type = callerTypeOf(props.$mcp_client_name, props.$mcp_client_user_agent);
      if (event.event !== '$mcp_initialize') return event;
      const seen = this.seenToday(userId ?? event.distinct_id, String(props.$mcp_client_name ?? ''));
      // shutdown() waits for posthog's pending promises, not for this hook. Hold one open until a macrotask after the
      // check: by then the SDK has handed the event to capture() (microtasks only), whose own pending promise
      // shutdown then waits for too, so a flush that starts during the lookup still sends the event.
      posthog.addPendingPromise(
        seen.catch(() => undefined).then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      );
      return seen.then((repeated) => (repeated ? null : event));
    };
  }

  /**
   * Whether this user has already handshaken with this client today, as this instance's memory or the shared store
   * remembers; marks it otherwise. Clients handshake on every connection, many times a day, and each later handshake
   * only repeats what the first one reported. A failing store costs a duplicate event, never a lost one, as do two
   * instances checking the same mark at once.
   */
  private async seenToday(who: string, client: string): Promise<boolean> {
    if (!who) return false;
    const day = new Date(this.now() + DAY_OFFSET_MS).toISOString().slice(0, 10);
    const key = HANDSHAKE_KEY_PREFIX + (await sha256(`${who}\n${client}\n${day}`));
    if (this.handshakes.has(key)) return true;
    if (this.handshakes.size >= HANDSHAKE_MAX_ENTRIES) {
      const oldest = this.handshakes.values().next().value;
      if (oldest !== undefined) this.handshakes.delete(oldest);
    }
    this.handshakes.add(key);
    const shared = this.options.shared;
    if (!shared) return false;
    try {
      if ((await shared.get(key)) !== null) return true;
      await shared.put(key, '1', { expirationTtl: HANDSHAKE_TTL_S });
    } catch (error) {
      console.warn('shared handshake mark failed:', error);
    }
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
export function analyticsFromConfig(
  cfg: Config,
  fetchImpl?: typeof fetch,
  shared?: AnalyticsOptions['shared']
): McpAnalytics | undefined {
  if (!cfg.posthogApiKey) return undefined;
  return new McpAnalytics({
    apiKey: cfg.posthogApiKey,
    host: cfg.posthogHost,
    collectIntent: cfg.collectIntent,
    fetch: fetchImpl,
    shared
  });
}
