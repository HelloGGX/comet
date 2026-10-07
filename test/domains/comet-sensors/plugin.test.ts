import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryPluginStateStore, PluginRuntime } from '../../../domains/comet-plugin/index.js';
import {
  createSensorsDashboardContribution,
  createSensorsPluginDescriptor,
  SENSORS_PLUGIN_ID,
} from '../../../domains/comet-sensors/index.js';

describe('Sensors plugin descriptor', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-sensors-plugin-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('contributes an independent page that loads the show capability', async () => {
    const page = createSensorsDashboardContribution();
    const snapshot = { projectRoot, sources: [], errors: [] };
    const invoke = vi.fn().mockResolvedValue(snapshot);

    expect(page).toMatchObject({ id: 'sensors', label: 'Sensors', route: '/plugins/sensors' });
    await expect(page.load?.({ projectId: 'project', invoke })).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('show');
  });

  it('registers only in project scope and exposes a read-only show capability', async () => {
    const descriptor = createSensorsPluginDescriptor({ projectRoot });
    const runtime = new PluginRuntime({
      cometVersion: '0.4.0',
      store: new MemoryPluginStateStore(),
      descriptors: [descriptor],
    });
    const scope = { scope: 'project' as const, projectId: 'project' };
    await runtime.reconcileFirstParty();

    expect(descriptor).toMatchObject({
      id: SENSORS_PLUGIN_ID,
      kind: 'first-party',
      scopes: ['project'],
    });
    await expect(runtime.dashboardPages('user')).resolves.toEqual([]);
    await expect(runtime.dashboardPages(scope)).resolves.toEqual([
      expect.objectContaining({
        pluginId: SENSORS_PLUGIN_ID,
        label: 'Sensors',
        route: '/plugins/sensors',
      }),
    ]);
    await expect(runtime.invoke(SENSORS_PLUGIN_ID, 'show', undefined, scope)).resolves.toEqual({
      projectRoot,
      sources: [],
      errors: [],
    });
    await expect(
      runtime.invoke(SENSORS_PLUGIN_ID, 'run', { command: 'ignored' }, scope, {
        throwOnError: true,
      }),
    ).rejects.toThrow('Sensors 不支持此操作：run');
    expect(runtime.diagnostics()).toContainEqual(
      expect.objectContaining({
        pluginId: SENSORS_PLUGIN_ID,
        code: 'execution-failed',
        phase: 'invoke',
      }),
    );
  });
});
