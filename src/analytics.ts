/**
 * PostHog MCP analytics（@posthog/mcp）：HTTP 部署上报工具使用情况。stdio 跑在用户自己的机器上，不上报。
 *
 * 采集口径与 goldendata 内置 MCP（TrackMCPEventService）一致：
 * - 只报 $mcp_initialize 与 $mcp_tool_call；tools/list、resources/*、$identify、$exception 一律丢弃；
 * - 工具调用只记参数名（$mcp_input_keys），不记参数值，也不记返回内容；失败时记类别与截断后的报错；
 * - 意图：每个工具加一个 context 参数，让模型写用户想做什么（$mcp_intent）。SDK 发出前会抹掉其中的邮箱 /
 *   手机号 / IP / 卡号；JINSHUJU_MCP_COLLECT_INTENT=false 整个关掉（参数不再下发，也不再上报）；
 * - distinct_id = 金数据用户 id（GET /me 的结果），$session_id 由令牌哈希派生：同一个令牌一个会话；
 * - 同一会话的 initialize 一天只报一次（进程内去重，Workers 多实例时只能尽力而为）。
 *
 * SDK 的其它注入一律不开：不加 llm_model / conversation_id 参数，不加 get_more_tools / send_feedback 工具。
 *
 * PostHog 客户端按请求新建、请求结束时 shutdown，不跨请求共用：posthog-node 把前后两次 flush 串成一条链，Workers 里
 * 一个请求的上下文结束后它没发完的 flush 永远不会有结果，共用一个客户端会让之后每个请求的上报都挂在那条链上
 * （运行时报 "code had hung"，事件一条也发不出去）。
 */
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { deriveSessionIdFromMCPSession, instrument, type BeforeSendFn } from '@posthog/mcp';
import { PostHog, type PostHogOptions } from 'posthog-node';
import { sha256, userIdOf } from './auth.js';
import type { Config } from './config.js';
import { TOOLS } from './tools.js';
import { CONTEXT_ARGUMENT } from './validation.js';

/** 与 goldendata 内置 MCP 用同一句话问模型，两边的 $mcp_intent 才可比。 */
export const CONTEXT_DESCRIPTION = "Why are you calling this tool? Briefly describe the user's goal.";
export const CONTEXT_INSTRUCTIONS =
  `Every tool takes a \`${CONTEXT_ARGUMENT}\` argument: say what the user is actually trying to get done, ` +
  'in their own words, rather than restating what the tool does — it is what tells us which needs these tools ' +
  'are being asked to serve. Leave personal details (phone numbers, ID numbers, addresses) out of it.';

const KEPT_EVENTS = new Set(['$mcp_initialize', '$mcp_tool_call']);
/** SDK 缺省会带上（脱敏后的）入参和返回内容；口径是只记参数名，所以整个去掉。 */
const DROPPED_PROPERTIES = ['$mcp_parameters', '$mcp_response', '$mcp_tool_description'];
const HANDSHAKE_TTL_MS = 24 * 60 * 60_000;
const HANDSHAKE_MAX_ENTRIES = 2000;
/** 请求结束时发完攒下的事件的上限：一次请求 + 一次重试都在里面 */
const SHUTDOWN_TIMEOUT_MS = 15_000;
/**
 * $mcp_input_keys 只记 openapi 里声明过的参数名：SDK 读不懂 fromJsonSchema 产物里的声明，自己给它一份全集
 * （各工具的参数名并在一起，外加 get_schema 的 name）。模型编出来的键名一律记成 [redacted]。
 */
const DECLARED_PARAMETER_NAMES = new Set<string>([
  'name',
  ...TOOLS.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {}))
]);

export interface AnalyticsOptions {
  /** PostHog 项目 token（phc_…） */
  apiKey: string;
  /** PostHog 上报地址 */
  host: string;
  /** 是否下发 context 参数并上报 $mcp_intent，缺省开 */
  collectIntent?: boolean;
  /** 测试用：注入上报用的 fetch */
  fetch?: typeof fetch;
  now?: () => number;
  /** 上报 PostHog 的单次请求超时（毫秒），缺省 5 秒；测试用 */
  requestTimeoutMs?: number;
}

/** 一个请求的埋点句柄。 */
export interface RequestAnalytics {
  /** 把本次请求攒下的事件发出去并关掉客户端。Workers 上放进 waitUntil；Node 上不必等。 */
  flush(): Promise<void>;
}

/** SDK 内部日志只在出问题时转到 console；每个请求都会打的 "Successfully set up…" 不要。 */
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

  /** 给本次请求的 McpServer 装上埋点：用户、会话、PostHog 客户端都闭包在这一个请求里。 */
  async instrument(server: McpServer, authInfo?: AuthInfo): Promise<RequestAnalytics> {
    const sessionId = authInfo ? deriveSessionIdFromMCPSession(await sha256(authInfo.token)) : undefined;
    const distinctId = userIdOf(authInfo);
    const posthogOptions: PostHogOptions & { fetch?: unknown } = {
      host: this.options.host,
      // 事件由服务端发出，IP 是本服务的；按它做 GeoIP 会把用户的地理属性改成机房所在地。
      disableGeoip: true,
      // 一个请求只发一批；发不出去最多重试一次，别拖过 waitUntil 的时限。
      requestTimeout: this.options.requestTimeoutMs ?? 5_000,
      fetchRetryCount: 1,
      fetchRetryDelay: 1_000,
      fetch: this.options.fetch
    };
    const posthog = new PostHog(this.options.apiKey, posthogOptions);
    // posthog-node 发不出去只在 debug 模式下打日志；记下来，flush 时抛给调用方（console + Sentry）。
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
        // SDK 自己的会话是每个请求新开的；换成按令牌派生的。没认出用户时 distinct_id 就是会话 id，一并换。
        if (event.distinct_id === props.$session_id) event.distinct_id = sessionId;
        props.$session_id = sessionId;
      }
      if (event.event === '$mcp_initialize' && this.repeatedHandshake(String(props.$session_id ?? ''))) return null;
      return event;
    };
  }

  /** 客户端在一个连接上会反复握手，后面的握手报的都是第一次已经报过的东西。 */
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

  /** 等所有还在发的请求上报发完：Node 进程退出前、测试里用。 */
  async flush(): Promise<void> {
    await Promise.allSettled(this.inflight);
  }

  /** 进程退出前调用：同 flush。 */
  shutdown(): Promise<void> {
    return this.flush();
  }
}

/** 配了 POSTHOG_API_KEY 才上报。 */
export function analyticsFromConfig(cfg: Config, fetchImpl?: typeof fetch): McpAnalytics | undefined {
  if (!cfg.posthogApiKey) return undefined;
  return new McpAnalytics({
    apiKey: cfg.posthogApiKey,
    host: cfg.posthogHost,
    collectIntent: cfg.collectIntent,
    fetch: fetchImpl
  });
}
