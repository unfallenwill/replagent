import type { EvalTask } from '../types.js';
import { CACHE_MIGRATION } from './cache.js';
import { CHECKOUT } from './checkout.js';
import { CONFIG_RESOLVER } from './config.js';
import { CSV_PIPELINE } from './csv.js';
import { GRAPH_SCHEDULER } from './graph.js';
import { RECOVERY_MIGRATION } from './migration.js';
import { EVOLVING_POLICY } from './policy.js';
import { RECONCILIATION } from './reconcile.js';

export const TASKS: readonly EvalTask[] = [
  CHECKOUT,
  CSV_PIPELINE,
  CACHE_MIGRATION,
  RECONCILIATION,
  EVOLVING_POLICY,
  GRAPH_SCHEDULER,
  CONFIG_RESOLVER,
  RECOVERY_MIGRATION,
];
