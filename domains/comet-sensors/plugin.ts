import type { PluginDashboardContribution, PluginDescriptor } from '../comet-plugin/index.js';
import { readSensorsDashboardSnapshot } from './snapshot.js';

export const SENSORS_PLUGIN_ID = 'comet.sensors';

export function createSensorsDashboardContribution(): PluginDashboardContribution {
  return {
    id: 'sensors',
    label: 'Sensors',
    route: '/plugins/sensors',
    load: async ({ invoke }) => invoke('show'),
  };
}

export function createSensorsPluginDescriptor(options: {
  readonly projectRoot: string;
}): PluginDescriptor {
  return {
    id: SENSORS_PLUGIN_ID,
    kind: 'first-party',
    version: '1.0.0',
    scopes: ['project'],
    compatible: () => true,
    create: () => ({
      dashboard: createSensorsDashboardContribution(),
      invoke: async (capability) => {
        if (capability !== 'show') throw new Error(`Sensors 不支持此操作：${capability}`);
        return readSensorsDashboardSnapshot(options.projectRoot);
      },
    }),
  };
}
