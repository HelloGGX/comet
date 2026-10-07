import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { RaceSafeReadError, readFileRaceSafe } from '../../platform/fs/race-safe-read.js';

export interface SensorsScore {
  value: number;
  direction: 'more' | 'less';
  description: string;
  threshold: number | null;
}

export interface SensorsFinding {
  message: string;
  severity: 'error' | 'warning' | 'info';
  file: string | null;
  line: number | null;
  column: number | null;
  rule: string | null;
  context: string | null;
}

export interface SensorsReading {
  success: boolean;
  summary: string;
  score: SensorsScore | null;
  findings: SensorsFinding[];
  metrics: {
    key: string;
    label: string;
    value: number;
    unit: string | null;
    direction: 'more' | 'less';
    threshold: number | null;
  }[];
  guidance: { rule: string; body: string }[];
  formatted: { summary_llm: string; failures_llm: string };
}

export interface SensorsRunner {
  lastRun: string | null;
  status: 'success' | 'failure' | 'below_threshold' | 'pending' | 'disabled' | 'on_check';
  mode: string;
  reading: SensorsReading | null;
}

export interface SensorsState {
  lastUpdated: string | null;
  runners: Record<string, SensorsRunner>;
  snapshot: {
    snapshot_id: string;
    timestamp: string | null;
    runners: Record<string, SensorsRunner>;
  } | null;
  queryLog: { timestamp: string | null; command: string; runner: string | null }[];
}

export interface SensorsDashboardSource {
  configFile: string | null;
  stateFile: string;
  status: 'ready' | 'missing' | 'error';
  error?: string;
  state: SensorsState;
}

export interface SensorsDashboardSnapshot {
  projectRoot: string;
  sources: SensorsDashboardSource[];
  errors: string[];
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as ObjectValue;
}

function string(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value == null ? null : string(value, label);
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value == null ? null : number(value, label);
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new Error(`${label} 的值无效`);
  }
  return value as T;
}

function array(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

function score(value: unknown): SensorsScore | null {
  if (value == null) return null;
  const data = object(value, 'score');
  return {
    value: number(data.value, 'score.value'),
    direction: choice(data.direction, ['more', 'less'], 'score.direction'),
    description: string(data.description, 'score.description', ''),
    threshold: nullableNumber(data.threshold, 'score.threshold'),
  };
}

function reading(value: unknown, runner: ObjectValue): SensorsReading | null {
  // 上游仍支持 formatted、score 位于 runner 顶层的旧状态文件。
  if (value === undefined && runner.formatted !== undefined) {
    const formatted = object(runner.formatted, 'formatted');
    value = {
      success: runner.status === 'success' || runner.status === 'below_threshold',
      summary: formatted.summary_llm ?? '',
      score: runner.score,
      formatted,
    };
  }
  if (value == null) return null;
  const data = object(value, 'reading');
  if (typeof data.success !== 'boolean') throw new Error('reading.success 必须是布尔值');
  const formatted = data.formatted === undefined ? {} : object(data.formatted, 'formatted');
  return {
    success: data.success,
    summary: string(data.summary, 'reading.summary'),
    score: score(data.score),
    findings: array(data.findings, 'findings').map((entry) => {
      const finding = object(entry, 'finding');
      return {
        message: string(finding.message, 'finding.message'),
        severity: choice(
          finding.severity ?? 'error',
          ['error', 'warning', 'info'],
          'finding.severity',
        ),
        file: nullableString(finding.file, 'finding.file'),
        line: nullableNumber(finding.line, 'finding.line'),
        column: nullableNumber(finding.column, 'finding.column'),
        rule: nullableString(finding.rule, 'finding.rule'),
        context: nullableString(finding.context, 'finding.context'),
      };
    }),
    metrics: array(data.metrics, 'metrics').map((entry) => {
      const metric = object(entry, 'metric');
      return {
        key: string(metric.key, 'metric.key'),
        label: string(metric.label, 'metric.label'),
        value: number(metric.value, 'metric.value'),
        unit: nullableString(metric.unit, 'metric.unit'),
        direction: choice(metric.direction ?? 'less', ['more', 'less'], 'metric.direction'),
        threshold: nullableNumber(metric.threshold, 'metric.threshold'),
      };
    }),
    guidance: array(data.guidance, 'guidance').map((entry) => {
      const guidance = object(entry, 'guidance');
      return {
        rule: string(guidance.rule, 'guidance.rule'),
        body: string(guidance.body, 'guidance.body'),
      };
    }),
    formatted: {
      summary_llm: string(formatted.summary_llm, 'formatted.summary_llm', ''),
      failures_llm: string(formatted.failures_llm, 'formatted.failures_llm', ''),
    },
  };
}

function runners(value: unknown): Record<string, SensorsRunner> {
  return Object.fromEntries(
    Object.entries(object(value === undefined ? {} : value, 'runners')).map(([name, entry]) => {
      const data = object(entry, `runner ${name}`);
      return [
        name,
        {
          lastRun: nullableString(data.lastRun, 'lastRun'),
          status: choice(data.status, ['success', 'failure', 'below_threshold'], 'runner.status'),
          mode: string(data.mode, 'runner.mode', ''),
          reading: reading(data.reading, data),
        },
      ];
    }),
  );
}

function emptyState(): SensorsState {
  return { lastUpdated: null, runners: {}, snapshot: null, queryLog: [] };
}

function state(value: unknown): SensorsState {
  const data = object(value, 'state');
  const snapshot = data.snapshot == null ? null : object(data.snapshot, 'snapshot');
  return {
    lastUpdated: nullableString(data.lastUpdated, 'lastUpdated'),
    runners: runners(data.runners),
    snapshot: snapshot && {
      snapshot_id: string(snapshot.snapshot_id, 'snapshot_id', ''),
      timestamp: nullableString(snapshot.timestamp, 'snapshot.timestamp'),
      runners: runners(snapshot.runners),
    },
    queryLog: array(data.queryLog, 'queryLog').map((entry) => {
      const query = object(entry, 'queryLog entry');
      return {
        timestamp: nullableString(query.timestamp, 'queryLog.timestamp'),
        command: string(query.command, 'queryLog.command'),
        runner: nullableString(query.runner, 'queryLog.runner'),
      };
    }),
  };
}

function configuredRunners(value: unknown): Record<string, SensorsRunner> {
  const data = object(value, '配置');
  if (data.version !== 1) throw new Error('sensors 配置 version 必须为 1');
  const result: Record<string, SensorsRunner> = Object.create(null);
  for (const entry of array(data.runners, '配置 runners')) {
    const runner = object(entry, '配置 runner');
    const name = string(runner.name, 'runner.name');
    if (!name || Object.hasOwn(result, name)) throw new Error('runner.name 不能为空或重复');
    string(runner.command, 'runner.command');
    const mode = choice(runner.mode, ['watch', 'interval', 'triggered', 'on_check'], 'runner.mode');
    if (runner.enabled !== undefined && typeof runner.enabled !== 'boolean') {
      throw new Error('runner.enabled 必须是布尔值');
    }
    const interval = mode === 'interval' ? number(runner.interval, 'runner.interval') : null;
    if (interval !== null && interval <= 0) throw new Error('runner.interval 必须大于零');
    result[name] = {
      lastRun: null,
      status: runner.enabled === false ? 'disabled' : mode === 'on_check' ? 'on_check' : 'pending',
      mode: interval === null ? mode : `every ${interval / 1000}s`,
      reading: null,
    };
  }
  return result;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export async function readSensorsDashboardSnapshot(
  projectRoot: string,
): Promise<SensorsDashboardSnapshot> {
  const result: SensorsDashboardSnapshot = {
    projectRoot: path.resolve(projectRoot),
    sources: [],
    errors: [],
  };
  try {
    const root = await fs.realpath(result.projectRoot);
    const directory = path.join(root, '.sensors');
    const verifyDirectory = async () => {
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory
      ) {
        throw new Error('.sensors 必须是项目内的真实目录，不能使用符号链接或 junction');
      }
    };
    try {
      await verifyDirectory();
    } catch (error) {
      if (missing(error)) return result;
      throw error;
    }
    const read = async (name: string, maxBytes: number) => {
      const file = path.join(directory, name);
      try {
        const content = await readFileRaceSafe(file, maxBytes, {
          label: `.sensors/${name}`,
          verify: async (_checkpoint, { realPath }) => {
            await verifyDirectory();
            if (!inside(root, realPath) || path.dirname(realPath) !== directory) {
              throw new Error('sensors 文件必须位于项目的 .sensors 目录内');
            }
          },
        });
        return content.bytes.toString('utf8').replace(/^\uFEFF/, '');
      } catch (error) {
        if (error instanceof RaceSafeReadError) {
          const reasons = {
            'not-regular-file': '必须是普通文件，不能使用符号链接或 junction',
            'too-large': `超过 ${maxBytes / (1024 * 1024)} MiB 大小限制`,
            changed: '读取期间文件发生变化，请刷新重试',
          };
          throw new Error(reasons[error.reason], { cause: error });
        }
        throw error;
      }
    };
    const stems = new Set<string>();
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (entry.name.endsWith('.sensors.yaml')) stems.add(entry.name.slice(0, -13));
      else if (entry.name.endsWith('.state.json')) stems.add(entry.name.slice(0, -11));
      if (stems.size > 32) {
        result.errors.push('sensors 来源超过 32 个，本次仅显示前 32 个');
        break;
      }
    }
    await verifyDirectory();
    for (const stem of [...stems].sort().slice(0, 32)) {
      const configName = `${stem}.sensors.yaml`;
      const stateName = `${stem}.state.json`;
      const source: SensorsDashboardSource = {
        configFile: null,
        stateFile: `.sensors/${stateName}`,
        status: 'missing',
        state: emptyState(),
      };
      result.sources.push(source);
      let configured: Record<string, SensorsRunner> = {};
      const errors: string[] = [];
      try {
        await fs.lstat(path.join(directory, configName));
        source.configFile = `.sensors/${configName}`;
        configured = configuredRunners(parse(await read(configName, 1024 * 1024)));
      } catch (error) {
        if (!missing(error)) errors.push(`${configName}: ${message(error)}`);
      }
      try {
        source.state = state(JSON.parse(await read(stateName, 8 * 1024 * 1024)));
        source.status = 'ready';
      } catch (error) {
        if (!missing(error)) errors.push(`${stateName}: ${message(error)}`);
      }
      source.state.runners = Object.fromEntries([
        ...Object.entries(configured).map(([name, runner]) => [
          name,
          runner.status === 'on_check' || !Object.hasOwn(source.state.runners, name)
            ? runner
            : { ...source.state.runners[name], mode: runner.mode },
        ]),
        ...Object.entries(source.state.runners).filter(
          ([name]) => !Object.hasOwn(configured, name),
        ),
      ]);
      if (errors.length) {
        source.status = 'error';
        source.error = errors.join('\n');
      }
    }
  } catch (error) {
    result.errors.push(message(error));
  }
  return result;
}
