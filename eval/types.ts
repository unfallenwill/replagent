import type { LlmPort, ReasoningEffort } from '../src/domain/ports/llm.js';
import type { UiEvent } from '../src/domain/ports/ui.js';

export type EvalMode = 'live' | 'reference';
export type EvalSuite = 'regression' | 'capability';

/** Checks describe observable results, never a required sequence of tools. */
export type EvalCheck =
  | { readonly id: string; readonly type: 'file'; readonly path: string; readonly content: string }
  | { readonly id: string; readonly type: 'json'; readonly path: string; readonly value: unknown }
  | { readonly id: string; readonly type: 'unchanged'; readonly path: string }
  | { readonly id: string; readonly type: 'absent'; readonly path: string }
  | {
      readonly id: string;
      readonly type: 'answer';
      readonly includes: string;
      readonly turn?: number;
    }
  | { readonly id: string; readonly type: 'node'; readonly code: string };

export interface EvalTask {
  readonly id: string;
  readonly suite: EvalSuite;
  readonly description: string;
  readonly fixtures: Readonly<Record<string, string>>;
  /** Turns share one workspace and one agent. Different trials share neither. */
  readonly turns: readonly string[];
  readonly checks: readonly EvalCheck[];
  /** A known solution for testing the task and graders, not a model score. */
  readonly reference: readonly string[];
}

export interface EvalBudget {
  readonly timeoutMs: number;
  readonly maxCalls: number;
  readonly maxSteps: number;
  readonly maxTokens: number;
}

export interface SubjectContext {
  readonly cwd: string;
  readonly llm: LlmPort;
  readonly systemPrompt: string;
  readonly budget: EvalBudget;
  readonly emit: (event: UiEvent) => void;
}

/** A candidate owns its prompt/runtime cooperation; the evaluator owns success. */
export interface EvalSubject {
  send(text: string, signal: AbortSignal): Promise<void>;
  close(): void | Promise<void>;
}

export type SubjectFactory = (context: SubjectContext) => EvalSubject | Promise<EvalSubject>;

export interface EvalConfig {
  readonly mode: EvalMode;
  readonly model: string;
  readonly endpoint: string;
  readonly effort: ReasoningEffort;
  readonly trials: number;
  readonly concurrency: number;
  readonly budget: EvalBudget;
  readonly candidate: string;
  readonly systemPrompt: string;
  readonly out: string;
}

export interface CheckResult {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface Answer {
  readonly turn: number;
  readonly text: string;
}

export interface TrialMetrics {
  readonly wallMs: number;
  readonly calls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly steps: number;
  readonly toolCalls: number;
  readonly replErrors: number;
}

export interface TrialResult {
  readonly taskId: string;
  readonly attempt: number;
  readonly status: 'completed' | 'timeout' | 'budget' | 'error';
  readonly passed: boolean;
  readonly error?: string;
  readonly checks: readonly CheckResult[];
  readonly metrics: TrialMetrics;
  /** Relative to the report directory. */
  readonly artifacts: string;
}

export interface TaskSummary {
  readonly id: string;
  readonly suite: EvalSuite;
  readonly hash: string;
  readonly trials: number;
  readonly passed: number;
  readonly checkPassRates: Readonly<Record<string, number>>;
}

export interface EvalReport {
  readonly schema: 1;
  readonly at: string;
  readonly mode: EvalMode;
  readonly model: string;
  readonly endpoint: string;
  readonly effort: ReasoningEffort;
  readonly concurrency?: number;
  readonly budget: EvalBudget;
  readonly candidate: { readonly path: string; readonly hash: string };
  readonly promptHash: string;
  readonly sourceHash: string;
  readonly graderHash?: string;
  readonly runtime: { readonly node: string; readonly platform: string; readonly arch: string };
  readonly tasks: readonly TaskSummary[];
  readonly results: readonly TrialResult[];
}
