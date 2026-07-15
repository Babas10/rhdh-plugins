import {
  createFrontendPlugin,
  ApiBlueprint,
} from '@backstage/frontend-plugin-api';
import { meteringApiFactory } from './api';
import { MeteringSummaryCard } from './components/MeteringSummaryCard';
import { MeteringTabContent } from './components/MeteringTabContent';

// Named exports used as importName in dynamic-plugins.yaml pluginConfig:
// - MeteringSummaryCard mounts on entity.page.overview/cards
// - MeteringTabContent mounts on entity.page.metering/cards (the dedicated tab)
export { MeteringSummaryCard, MeteringTabContent };

const MeteringApiBlueprint = ApiBlueprint.make({
  name: 'metering-api',
  params: defineParams => defineParams(meteringApiFactory),
});

export default createFrontendPlugin({
  pluginId: 'metering',
  extensions: [MeteringApiBlueprint],
});
