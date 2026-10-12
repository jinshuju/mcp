/**
 * 评测体系的数据形状：样本任务、断言、夹具（测评数据）、一次运行的记录。
 */

export const CATEGORIES = ['找表单', '读数据', '统计汇总', '建表单', '改设置', '批量写入', '导入'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface TaskFilter {
  field: string;
  operator: string;
  value?: unknown;
}

/** 对一个字段定义的期望（建表单 / 改结构类任务的状态断言） */
export interface FieldExpect {
  /** 字段标题完全相等 */
  label?: string;
  /** 字段标题包含 */
  label_contains?: string;
  /** FieldDefinition.type 的取值（如 single_line_text / single_choice / rating），可给多个候选 */
  type?: string | string[];
  required?: boolean;
  unique?: boolean;
  /** 选项数 */
  choices?: number;
  choices_min?: number;
  /** 必须包含的选项显示值 */
  choices_include?: string[];
  /** 位于标题为该值的字段之后 */
  after_label?: string;
  /** 字段不应存在 */
  absent?: boolean;
}

export type StateCheck =
  | {
      check: 'entry_count';
      fixture: string;
      filters?: TaskFilter[];
      keyword?: string;
      equals?: number;
      min?: number;
      max?: number;
    }
  | {
      check: 'entries_match';
      fixture: string;
      filters?: TaskFilter[];
      min?: number;
      /** 每条匹配数据都应满足的字段值（键为夹具字段 key） */
      all?: Record<string, unknown>;
      /** 不应有任何匹配数据满足的字段值 */
      none?: Record<string, unknown>;
    }
  | {
      check: 'form_created';
      name?: string;
      name_contains?: string;
      scene?: 'exam' | 'evaluation';
      min_fields?: number;
      max_fields?: number;
      fields?: FieldExpect[];
      setting?: Record<string, unknown>;
      exam_setting?: Record<string, unknown>;
      evaluation_setting?: Record<string, unknown>;
      /** 与某个夹具表单字段数一致（复制表单） */
      same_field_count_as?: string;
    }
  | ({ check: 'form_field'; fixture: string } & FieldExpect)
  | {
      check: 'form_props';
      fixture: string;
      name?: string;
      name_contains?: string;
      description_contains?: string;
      setting?: Record<string, unknown>;
      theme?: Record<string, unknown>;
      field_count?: number;
    };

export interface TaskExpect {
  tools?: { must_call?: string[]; any_of?: string[]; must_not_call?: string[] };
  max_turns?: number;
  max_tool_calls?: number;
  answer?: {
    contains?: string[];
    contains_any?: string[];
    not_contains?: string[];
    regex?: string;
    /** 用 LLM-as-judge 逐条核对的事实 */
    claims?: string[];
  };
  state?: StateCheck[];
}

export interface Task {
  id: string;
  category: Category;
  title: string;
  prompt: string;
  /** 样本来源（线上会话模式 / 文档用例） */
  source?: string;
  /** 依赖的夹具别名 */
  fixtures?: string[];
  /** 会修改夹具数据：运行前后重置，并与其它任务互斥 */
  writes?: boolean;
  /** 会创建新表单：运行后把新表单移入产出文件夹 */
  creates_forms?: boolean;
  /** 允许的最多模型轮次（LLM 调用数），缺省 12 */
  max_turns?: number;
  expect: TaskExpect;
}

// ---- 夹具 ----

export interface FixtureField {
  key: string;
  type: string;
  label: string;
  required?: boolean;
  unique?: boolean;
  choices?: string[];
  precision?: string;
  rating_max?: number;
  notes?: string;
}

export interface FixtureForm {
  alias: string;
  name: string;
  description?: string;
  fields: FixtureField[];
  setting?: Record<string, unknown>;
  /** 种子数据，键为字段 key */
  entries?: Record<string, unknown>[];
}

export interface FixturesSpec {
  folder: string;
  output_folder: string;
  results_form: string;
  forms: FixtureForm[];
}

export interface SeededField {
  api_code: string;
  type: string;
  label: string;
}

export interface SeededForm {
  alias: string;
  name: string;
  token: string;
  url: string;
  fields: Record<string, SeededField>;
  seed_serials: number[];
  theme_primary_color?: string;
}

export interface FixtureState {
  account: { user_id: string; user_name: string; billing_account_id: string; billing_account_name: string };
  api_base_url: string;
  folder_token: string;
  output_folder_token: string;
  seeded_at: string;
  forms: Record<string, SeededForm>;
  results_form_token?: string;
}

// ---- 运行记录 ----

export interface ToolCallRecord {
  index: number;
  turn: number;
  name: string;
  arguments: unknown;
  is_error: boolean;
  result_chars: number;
  result_preview: string;
  duration_ms: number;
  error_message?: string;
}

export interface TurnUsage {
  turn: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  latency_ms: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
}

export interface AssertionResult {
  kind: 'tools' | 'turns' | 'answer' | 'claim' | 'state';
  name: string;
  pass: boolean;
  detail?: string;
}

export type RunStatus = 'passed' | 'failed' | 'error';

export interface RunRecord {
  run_id: string;
  job_id: string;
  started_at: string;
  finished_at: string;
  task_id: string;
  category: Category;
  model: string;
  mcp: string;
  mcp_version: string;
  status: RunStatus;
  passed: boolean;
  assertions: AssertionResult[];
  final_answer: string;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  tool_retries: number;
  llm_retries: number;
  truncated_results: number;
  exhausted: boolean;
  usage: Usage;
  turn_usage: TurnUsage[];
  calls: ToolCallRecord[];
  duration_ms: number;
  judge_model?: string;
  error?: string;
}

export interface RunMeta {
  run_id: string;
  started_at: string;
  finished_at?: string;
  models: string[];
  targets: { name: string; kind: string; url?: string; version: string; tool_count: number; catalog_chars: number }[];
  judge_model: string;
  task_count: number;
  repeat: number;
  git_commit: string;
  openapi_sha: string;
  account: FixtureState['account'];
  llm_base_url: string;
}
