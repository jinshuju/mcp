/**
 * Data shapes of the eval system: sample tasks, assertions, fixtures (eval data) and the record of one run.
 */

/** Category names are data: task files, run records and the results form's choices all use them as written. */
export const CATEGORIES = ['找表单', '读数据', '统计汇总', '建表单', '改设置', '批量写入', '导入'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface TaskFilter {
  field: string;
  operator: string;
  value?: unknown;
}

/** What a field definition should look like (state assertions of create-form / change-structure tasks) */
export interface FieldExpect {
  /** Field label equals this exactly */
  label?: string;
  /** Field label contains this */
  label_contains?: string;
  /** FieldDefinition.type value (e.g. single_line_text / single_choice / rating); several candidates allowed */
  type?: string | string[];
  required?: boolean;
  unique?: boolean;
  /** Number of choices */
  choices?: number;
  choices_min?: number;
  /** Choice labels that must be present */
  choices_include?: string[];
  /** Comes right after the field with this label */
  after_label?: string;
  /** The field must not exist */
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
      /** Field values every matching entry must have (keyed by fixture field key) */
      all?: Record<string, unknown>;
      /** Field values no matching entry may have */
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
      /** Same field count as this fixture form (copying a form) */
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
    /** Facts an LLM judge checks one by one */
    claims?: string[];
  };
  state?: StateCheck[];
}

export interface Task {
  id: string;
  category: Category;
  title: string;
  prompt: string;
  /** Where the sample comes from (a production session pattern / a documented use case) */
  source?: string;
  /** Aliases of the fixtures it depends on */
  fixtures?: string[];
  /** Changes fixture data: reset before and after the run, and exclusive with other tasks */
  writes?: boolean;
  /** Creates forms (marked in `tasks`); every form a run creates is deleted when the run ends */
  creates_forms?: boolean;
  /** Most model turns allowed (LLM calls), 12 by default */
  max_turns?: number;
  /** The user's local files (name → content): written into a working directory the model reaches with run_command (see shell.ts) */
  files?: Record<string, string>;
  expect: TaskExpect;
}

// ---- Fixtures ----

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
  /** Seed entries, keyed by field key */
  entries?: Record<string, unknown>[];
}

export interface FixturesSpec {
  folder: string;
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
  seeded_at: string;
  forms: Record<string, SeededForm>;
  results_form_token?: string;
}

// ---- Run records ----

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
