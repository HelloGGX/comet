import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultCometPluginBridge } from '../../../domains/comet-plugin/index.js';
import { SENSORS_PLUGIN_ID } from '../../../domains/comet-sensors/index.js';
import { createDefaultDashboardPluginHostFactory } from '../../../domains/dashboard/default-plugin-host.js';
import { startDashboardServer } from '../../../domains/dashboard/server.js';
import { resolveStableProjectId } from '../../../platform/paths/project-identity.js';

async function writeSensorsState(projectRoot: string, summary: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, '.sensors'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.sensors', 'project.state.json'),
    JSON.stringify({
      lastUpdated: '2026-10-07T00:00:00.000Z',
      runners: {
        lint: {
          lastRun: '2026-10-07T00:00:00.000Z',
          status: 'failure',
          mode: 'triggered',
          reading: {
            success: false,
            summary,
            findings: [{ message: summary, file: 'app/main.ts', line: 5, severity: 'error' }],
          },
        },
      },
    }),
  );
}

async function request(port: number, pathname: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: await response.json() };
}

describe('Sensors default Dashboard plugin', () => {
  let root: string;
  let projectRoot: string;
  let options: {
    homeDirectory: string;
    stateRoot: string;
    memoryRoot: string;
    knowledgeCacheRoot: string;
  };
  let close: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-sensors-dashboard-'));
    projectRoot = path.join(root, 'project');
    options = {
      homeDirectory: root,
      stateRoot: path.join(root, 'plugins'),
      memoryRoot: path.join(root, 'memory'),
      knowledgeCacheRoot: path.join(root, 'knowledge'),
    };
    await writeSensorsState(projectRoot, 'Project lint failure');
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shares the CLI catalog and keeps Sensors data isolated between projects', async () => {
    const secondProject = path.join(root, 'second-project');
    await writeSensorsState(secondProject, 'Second project warning');
    const factory = createDefaultDashboardPluginHostFactory(options);
    const host = await factory('dashboard-id', projectRoot);
    const otherHost = await factory('second-dashboard-id', secondProject);
    const bridge = await createDefaultCometPluginBridge({
      ...options,
      projectRoot,
      projectId: resolveStableProjectId(projectRoot),
    });

    await expect(host.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: SENSORS_PLUGIN_ID,
          label: 'Sensors',
          route: '/plugins/sensors',
          status: 'enabled',
          diagnostics: [],
        }),
      ]),
    );
    await expect(host.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({
      data: {
        projectRoot,
        sources: [
          {
            status: 'ready',
            state: {
              runners: {
                lint: { reading: { summary: 'Project lint failure' } },
              },
            },
          },
        ],
      },
    });
    await expect(otherHost.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({
      data: {
        projectRoot: secondProject,
        sources: [
          {
            state: {
              runners: {
                lint: { reading: { summary: 'Second project warning' } },
              },
            },
          },
        ],
      },
    });
    const scope = { scope: 'project' as const, projectId: resolveStableProjectId(projectRoot) };
    await expect(bridge.pluginRuntime.dashboardPages(scope)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: SENSORS_PLUGIN_ID, route: '/plugins/sensors' }),
      ]),
    );
    await expect(
      bridge.pluginRuntime.invoke(SENSORS_PLUGIN_ID, 'show', undefined, scope),
    ).resolves.toEqual((await host.get(SENSORS_PLUGIN_ID)).data);
    expect(bridge.pluginRuntime.diagnostics()).not.toContainEqual(
      expect.objectContaining({ pluginId: SENSORS_PLUGIN_ID, code: 'missing' }),
    );
  });

  it('preserves a paused page through host recreation and allows re-enabling it', async () => {
    const factory = createDefaultDashboardPluginHostFactory(options);
    const host = await factory('dashboard-id', projectRoot);
    await host.lifecycle(SENSORS_PLUGIN_ID, 'disable');
    const reopened = await factory('different-dashboard-id', projectRoot);

    await expect(reopened.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: SENSORS_PLUGIN_ID,
          status: 'disabled',
          globallyDisabled: false,
          projectPaused: true,
        }),
      ]),
    );
    await expect(reopened.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({ data: null });
    await expect(reopened.invoke(SENSORS_PLUGIN_ID, 'show')).rejects.toMatchObject({
      statusCode: 409,
    });
    await reopened.lifecycle(SENSORS_PLUGIN_ID, 'enable');
    await expect(reopened.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({
      status: 'enabled',
      projectPaused: false,
      data: { projectRoot },
    });
  });

  it('keeps a globally disabled page available for recovery', async () => {
    const bridge = await createDefaultCometPluginBridge({
      ...options,
      projectRoot,
      projectId: resolveStableProjectId(projectRoot),
    });
    await bridge.pluginRuntime.disable(SENSORS_PLUGIN_ID);
    const host = await createDefaultDashboardPluginHostFactory(options)(
      'dashboard-id',
      projectRoot,
    );

    await expect(host.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: SENSORS_PLUGIN_ID,
          status: 'disabled',
          globallyDisabled: true,
          projectPaused: false,
        }),
      ]),
    );
    await expect(host.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({ data: null });
    await host.lifecycle(SENSORS_PLUGIN_ID, 'enable');
    await expect(host.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({
      status: 'enabled',
      globallyDisabled: false,
      data: { projectRoot },
    });
  });

  it('respects an explicit uninstall when the default host is recreated', async () => {
    const factory = createDefaultDashboardPluginHostFactory(options);
    const host = await factory('dashboard-id', projectRoot);
    await host.lifecycle(SENSORS_PLUGIN_ID, 'uninstall');
    const reopened = await factory('dashboard-id', projectRoot);

    expect((await reopened.list()).some((page) => page.pluginId === SENSORS_PLUGIN_ID)).toBe(false);
    await expect(reopened.get(SENSORS_PLUGIN_ID)).rejects.toMatchObject({ statusCode: 404 });
    const bridge = await createDefaultCometPluginBridge({
      ...options,
      projectRoot,
      projectId: resolveStableProjectId(projectRoot),
    });
    await expect(bridge.pluginRuntime.get(SENSORS_PLUGIN_ID)).resolves.toMatchObject({
      status: 'uninstalled',
      explicitRemoval: true,
    });
  });

  it('serves show and lifecycle through the existing HTTP API without running configured commands', async () => {
    const marker = path.join(root, 'command-ran');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    )}`;
    await fs.writeFile(
      path.join(projectRoot, '.sensors', 'project.sensors.yaml'),
      `version: 1\nrunners:\n  - name: lint\n    command: ${JSON.stringify(command)}\n    mode: triggered\n`,
    );
    const webRoot = path.join(root, 'web');
    await fs.mkdir(webRoot);
    await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html>');
    const server = await startDashboardServer({
      projectPath: projectRoot,
      port: 0,
      webRoot,
      pluginHost: createDefaultDashboardPluginHostFactory(options),
    });
    close = server.close;
    const directory = await request(server.port, '/api/dashboard/projects');
    const base = `/api/dashboard/projects/${directory.body.currentProjectId}/plugins`;
    const endpoint = `${base}/${SENSORS_PLUGIN_ID}`;

    expect(await request(server.port, base)).toMatchObject({
      status: 200,
      body: {
        pages: expect.arrayContaining([
          expect.objectContaining({
            pluginId: SENSORS_PLUGIN_ID,
            route: '/plugins/sensors',
            status: 'enabled',
          }),
        ]),
      },
    });
    const page = await request(server.port, endpoint);
    expect(page).toMatchObject({
      status: 200,
      body: { data: { projectRoot, sources: [{ status: 'ready' }] } },
    });
    expect(await request(server.port, `${endpoint}/invoke`, { capability: 'show' })).toEqual({
      status: 200,
      body: { result: page.body.data },
    });
    expect(
      await request(server.port, `${endpoint}/invoke`, { capability: 'run', input: { command } }),
    ).toEqual({
      status: 400,
      body: { error: 'Sensors 不支持此操作：run', pluginId: SENSORS_PLUGIN_ID },
    });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(
      (await request(server.port, `${endpoint}/lifecycle`, { action: 'disable' })).status,
    ).toBe(200);
    expect(await request(server.port, endpoint)).toMatchObject({
      status: 200,
      body: { status: 'disabled', data: null },
    });
    expect((await request(server.port, `${endpoint}/invoke`, { capability: 'show' })).status).toBe(
      409,
    );
    expect((await request(server.port, `${endpoint}/lifecycle`, { action: 'enable' })).status).toBe(
      200,
    );
    expect(await request(server.port, endpoint)).toMatchObject({
      status: 200,
      body: { status: 'enabled', data: { projectRoot } },
    });
    expect(
      (await request(server.port, `${endpoint}/lifecycle`, { action: 'uninstall' })).status,
    ).toBe(200);
    const afterUninstall = await request(server.port, base);
    expect(
      afterUninstall.body.pages.some(
        (entry: { pluginId: string }) => entry.pluginId === SENSORS_PLUGIN_ID,
      ),
    ).toBe(false);
    expect((await request(server.port, endpoint)).status).toBe(404);
  });
});
