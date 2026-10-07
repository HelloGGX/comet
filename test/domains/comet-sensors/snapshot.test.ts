import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { readSensorsDashboardSnapshot } from '../../../domains/comet-sensors/snapshot.js';

describe('Sensors Dashboard 状态读取', () => {
  let temporary: string;
  let project: string;
  let directory: string;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-sensors-snapshot-'));
    project = path.join(temporary, 'project');
    directory = path.join(project, '.sensors');
    const home = path.join(temporary, 'home');
    await fs.mkdir(home);
    await fs.mkdir(directory, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  async function writeConfig(stem: string, runners: Record<string, unknown>[] = []) {
    await fs.writeFile(
      path.join(directory, `${stem}.sensors.yaml`),
      stringify({ version: 1, runners }),
    );
  }

  async function writeState(stem: string, state: unknown) {
    await fs.writeFile(path.join(directory, `${stem}.state.json`), JSON.stringify(state));
  }

  function configured(name: string, fields: Record<string, unknown> = {}) {
    return { name, parser: 'default', command: 'unused-command', mode: 'watch', ...fields };
  }

  function runner(fields: Record<string, unknown> = {}) {
    return {
      lastRun: '2026-10-05T11:44:08.996714',
      status: 'failure',
      mode: 'every 60s',
      reading: {
        success: false,
        summary: '1 warning',
        score: { value: 1, direction: 'less', description: 'Issues', threshold: 0 },
        findings: [
          {
            message: 'Prefer let',
            severity: 'warning',
            file: 'sample.js',
            line: 1,
            column: 2,
            rule: 'prefer-let',
            context: 'var x = 1;',
          },
        ],
        metrics: [
          {
            key: 'warnings',
            label: 'Warnings',
            value: 1,
            unit: null,
            direction: 'less',
            threshold: null,
          },
        ],
        guidance: [{ rule: 'prefer-let', body: 'Use const when possible.' }],
        extra: { ignored: true },
        formatted: {
          summary_llm: '1 warning',
          failures_llm: 'sample.js:1:2 Prefer let',
          summary_html: '<script>unsafe()</script>',
          failures_html: '<div>unsafe</div>',
          summary_terminal: '[yellow]1 warning[/yellow]',
        },
      },
      ...fields,
    };
  }

  it('没有 .sensors 目录时返回空页面数据', async () => {
    await fs.rmdir(directory);
    expect(await readSensorsDashboardSnapshot(project)).toEqual({
      projectRoot: project,
      sources: [],
      errors: [],
    });
  });

  it('展示配置中尚未运行、已停用和按需检查的 runner，不执行 command', async () => {
    const marker = path.join(project, 'command-ran');
    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'ran')"`;
    await writeConfig('demo', [
      configured('lint', { command, mode: 'interval', interval: 60000 }),
      configured('disabled', { enabled: false }),
      configured('query', { mode: 'on_check', parser: null }),
    ]);
    const snapshot = await readSensorsDashboardSnapshot(project);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.sources[0]).toMatchObject({
      configFile: '.sensors/demo.sensors.yaml',
      stateFile: '.sensors/demo.state.json',
      status: 'missing',
    });
    expect(snapshot.sources[0].state.runners).toEqual({
      lint: { lastRun: null, status: 'pending', mode: 'every 60s', reading: null },
      disabled: { lastRun: null, status: 'disabled', mode: 'watch', reading: null },
      query: { lastRun: null, status: 'on_check', mode: 'on_check', reading: null },
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(directory)).toEqual(['demo.sensors.yaml']);
  });

  it('检查方式变更后使用当前配置，保留已有检测结果且不写回状态', async () => {
    await writeConfig('demo', [configured('lint', { mode: 'interval', interval: 30000 })]);
    await writeState('demo', { runners: { lint: runner() } });
    const stateFile = path.join(directory, 'demo.state.json');
    const originalState = await fs.readFile(stateFile, 'utf8');
    const snapshot = await readSensorsDashboardSnapshot(project);
    expect(snapshot.sources[0].state.runners.lint).toMatchObject({
      mode: 'every 30s',
      status: 'failure',
      reading: { summary: '1 warning' },
    });
    await writeConfig('demo', [configured('lint')]);
    const refreshed = await readSensorsDashboardSnapshot(project);
    expect(refreshed.sources[0].state.runners.lint.mode).toBe('watch');
    expect(await fs.readFile(stateFile, 'utf8')).toBe(originalState);
  });

  it('配置名与原型属性重名时仍展示待检查状态', async () => {
    await writeConfig('demo', [
      configured('__proto__'),
      configured('constructor'),
      configured('toString'),
    ]);
    const snapshot = await readSensorsDashboardSnapshot(project);
    for (const name of ['__proto__', 'constructor', 'toString']) {
      expect(Object.hasOwn(snapshot.sources[0].state.runners, name)).toBe(true);
      expect(snapshot.sources[0].state.runners[name].status).toBe('pending');
    }
  });

  it('读取完整结构化报告、快照和查询记录，只返回文本格式', async () => {
    await writeConfig('demo', [configured('lint')]);
    const state = {
      lastUpdated: '2026-10-05T11:44:08.997134',
      runners: { lint: runner() },
      snapshot: {
        snapshot_id: 'before',
        timestamp: '2026-10-05T11:40:00',
        runners: { lint: runner({ status: 'below_threshold' }) },
      },
      queryLog: [{ timestamp: '2026-10-05T11:44:07', command: 'check', runner: null }],
    };
    await writeState('demo', state);
    const snapshot = await readSensorsDashboardSnapshot(project);
    const source = snapshot.sources[0];
    expect(source.status).toBe('ready');
    expect(source.state.lastUpdated).toBe(state.lastUpdated);
    expect(source.state.runners.lint).toMatchObject({
      status: 'failure',
      reading: {
        summary: '1 warning',
        score: { value: 1, threshold: 0 },
        findings: [{ file: 'sample.js', line: 1, column: 2 }],
        guidance: [{ rule: 'prefer-let' }],
      },
    });
    expect(source.state.runners.lint.reading?.formatted).toEqual({
      summary_llm: '1 warning',
      failures_llm: 'sample.js:1:2 Prefer let',
    });
    expect(source.state.runners.lint.reading).not.toHaveProperty('extra');
    expect(source.state.snapshot?.runners.lint.status).toBe('below_threshold');
    expect(source.state.queryLog).toEqual(state.queryLog);
    expect(JSON.stringify(snapshot)).not.toContain('<script>');
    expect(JSON.stringify(snapshot)).not.toContain('summary_terminal');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'demo.state.json'), 'utf8'))).toEqual(
      state,
    );
  });

  it('刷新重新读取状态，按需检查配置覆盖旧结果，保留额外 runner', async () => {
    await writeConfig('demo', [
      configured('lint'),
      configured('query', { mode: 'on_check' }),
      configured('disabled', { enabled: false }),
    ]);
    await writeState('demo', {
      runners: { lint: runner(), query: runner(), disabled: runner(), extra: runner() },
    });
    const first = await readSensorsDashboardSnapshot(project);
    expect(first.sources[0].state.runners.query.status).toBe('on_check');
    expect(first.sources[0].state.runners.disabled.status).toBe('failure');
    expect(first.sources[0].state.runners.extra.status).toBe('failure');
    await writeState('demo', {
      runners: {
        lint: runner({ status: 'success', reading: { success: true, summary: 'No warnings' } }),
      },
    });
    const refreshed = await readSensorsDashboardSnapshot(project);
    expect(refreshed.sources[0].state.runners.lint).toMatchObject({
      status: 'success',
      reading: { summary: 'No warnings' },
    });
    expect(refreshed.sources[0].state.runners).not.toHaveProperty('extra');
  });

  it('兼容 runner 顶层 formatted 和 score 的旧状态，包括旧快照', async () => {
    const legacy = {
      lastRun: '2026-10-05T11:40:00',
      status: 'below_threshold',
      score: { value: 70, direction: 'more' },
      formatted: {
        summary_llm: '70% coverage',
        failures_llm: 'Raise coverage',
        summary_html: '<b>70%</b>',
      },
    };
    await writeState('legacy', {
      runners: { coverage: legacy },
      snapshot: { snapshot_id: 'old', runners: { coverage: legacy } },
    });
    const source = (await readSensorsDashboardSnapshot(project)).sources[0];
    expect(source.configFile).toBeNull();
    expect(source.status).toBe('ready');
    expect(source.state.runners.coverage.reading).toMatchObject({
      success: true,
      summary: '70% coverage',
      score: { value: 70, direction: 'more', description: '', threshold: null },
    });
    expect(source.state.snapshot?.runners.coverage.reading?.summary).toBe('70% coverage');
  });

  it('损坏 JSON 和 YAML 只影响对应来源，其余状态继续展示', async () => {
    await writeState('good', { runners: { lint: runner() } });
    await fs.writeFile(path.join(directory, 'broken.state.json'), '{');
    await fs.writeFile(path.join(directory, 'bad-config.sensors.yaml'), 'version: [');
    await writeState('bad-config', { runners: { lint: runner() } });
    const snapshot = await readSensorsDashboardSnapshot(project);
    expect(snapshot.errors).toEqual([]);
    expect(
      snapshot.sources.find((source) => source.stateFile.endsWith('/good.state.json'))?.status,
    ).toBe('ready');
    expect(
      snapshot.sources.find((source) => source.stateFile.endsWith('/broken.state.json')),
    ).toMatchObject({ status: 'error', error: expect.stringContaining('broken.state.json') });
    const badConfig = snapshot.sources.find((source) =>
      source.stateFile.endsWith('/bad-config.state.json'),
    );
    expect(badConfig).toMatchObject({
      status: 'error',
      error: expect.stringContaining('bad-config.sensors.yaml'),
    });
    expect(badConfig?.state.runners.lint.status).toBe('failure');
  });

  it.each([
    [{ runners: null }, 'runners 必须是对象'],
    [{ runners: { lint: runner({ status: 'unknown' }) } }, 'runner.status 的值无效'],
    [
      { runners: { lint: runner({ reading: { success: 'false', summary: 'incorrect' } }) } },
      'reading.success 必须是布尔值',
    ],
    [
      {
        runners: {
          lint: runner({
            reading: { success: true, summary: 'ok', score: { value: '1', direction: 'less' } },
          }),
        },
      },
      'score.value 必须是有限数值',
    ],
    [
      {
        runners: {
          lint: runner({
            reading: {
              success: true,
              summary: 'ok',
              findings: [{ message: 'bad', severity: 'critical' }],
            },
          }),
        },
      },
      'finding.severity 的值无效',
    ],
    [
      {
        runners: {
          lint: runner({
            reading: {
              success: true,
              summary: 'ok',
              metrics: [{ key: 'x', label: 'X', value: 1, direction: 'unknown' }],
            },
          }),
        },
      },
      'metric.direction 的值无效',
    ],
  ])('非法状态字段返回明确错误，不展示检查通过：%j', async (state, error) => {
    await writeState('invalid', state);
    const source = (await readSensorsDashboardSnapshot(project)).sources[0];
    expect(source.status).toBe('error');
    expect(source.error).toContain(error);
    expect(source.state.runners).toEqual({});
  });

  it('非普通状态文件和配置文件返回错误', async () => {
    await fs.mkdir(path.join(directory, 'state-dir.state.json'));
    await fs.mkdir(path.join(directory, 'config-dir.sensors.yaml'));
    const snapshot = await readSensorsDashboardSnapshot(project);
    expect(snapshot.sources).toHaveLength(2);
    for (const source of snapshot.sources) {
      expect(source.status).toBe('error');
      expect(source.error).toContain('必须是普通文件');
    }
  });

  it('拒绝指向项目外目录的 .sensors 符号链接或 junction', async () => {
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(
      path.join(outside, 'secret.state.json'),
      JSON.stringify({ runners: { secret: runner() } }),
    );
    await fs.rmdir(directory);
    await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const snapshot = await readSensorsDashboardSnapshot(project);
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.errors).toEqual([expect.stringContaining('不能使用符号链接或 junction')]);
  });

  it('拒绝目录内指向项目外目录的状态文件 junction', async () => {
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(directory, 'outside.state.json'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const source = (await readSensorsDashboardSnapshot(project)).sources[0];
    expect(source.status).toBe('error');
    expect(source.error).toContain('必须是普通文件');
    expect(source.state.runners).toEqual({});
  });

  it.skipIf(process.platform === 'win32')('拒绝目录内指向外部普通文件的符号链接', async () => {
    const outside = path.join(temporary, 'secret.json');
    await fs.writeFile(outside, JSON.stringify({ runners: { secret: runner() } }));
    await fs.symlink(outside, path.join(directory, 'outside.state.json'));
    const source = (await readSensorsDashboardSnapshot(project)).sources[0];
    expect(source.status).toBe('error');
    expect(source.error).toContain('必须是普通文件');
    expect(source.state.runners).toEqual({});
  });

  it.each([
    ['huge.sensors.yaml', 1024 * 1024, '1 MiB'],
    ['huge.state.json', 8 * 1024 * 1024, '8 MiB'],
  ])('拒绝超过大小上限的 %s', async (file, bytes, limit) => {
    await fs.writeFile(path.join(directory, file as string), 'x'.repeat((bytes as number) + 1));
    const source = (await readSensorsDashboardSnapshot(project)).sources[0];
    expect(source.status).toBe('error');
    expect(source.error).toContain(`超过 ${limit} 大小限制`);
  });

  it('来源超过 32 个时明确提示并限制展示数量', async () => {
    for (let index = 0; index < 33; index++) await writeState(`source-${index}`, { runners: {} });
    await fs.writeFile(path.join(directory, 'unrelated.json'), '{}');
    const snapshot = await readSensorsDashboardSnapshot(project);
    expect(snapshot.sources).toHaveLength(32);
    expect(snapshot.errors).toEqual(['sensors 来源超过 32 个，本次仅显示前 32 个']);
  });
});
