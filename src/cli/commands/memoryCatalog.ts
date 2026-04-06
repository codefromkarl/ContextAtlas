import type { CommandRegistrar } from '../types.js';
import { logger } from '../../utils/logger.js';

export function registerMemoryCatalogCommands(cli: CommandRegistrar): void {
  cli.command('memory:rebuild-catalog', '从当前功能记忆重建 catalog').action(async () => {
    const { MemoryRouter } = await import('../../memory/MemoryRouter.js');
    const router = MemoryRouter.forProject(process.cwd());
    const catalog = await router.buildCatalog();

    logger.info(
      `Catalog 已重建：${Object.keys(catalog.modules).length} 个模块，${Object.keys(catalog.scopes).length} 个 scope`,
    );
  });

  cli
    .command('memory:check-consistency', '检查 feature memories 与 catalog 是否一致')
    .action(async () => {
      const { MemoryStore } = await import('../../memory/MemoryStore.js');
      const { MemoryRouter } = await import('../../memory/MemoryRouter.js');

      const store = new MemoryStore(process.cwd());
      const router = MemoryRouter.forProject(process.cwd());
      await router.initialize();

      const features = await store.listFeatures();
      const featureNames = new Set(
        features.map((feature) => feature.name.toLowerCase().trim().replace(/\s+/g, '-')),
      );
      const catalog = router.getCatalog();
      const catalogNames = new Set(Object.keys(catalog?.modules || {}));

      const missingFromCatalog = [...featureNames].filter((name) => !catalogNames.has(name));
      const staleCatalogEntries = [...catalogNames].filter((name) => !featureNames.has(name));

      if (missingFromCatalog.length === 0 && staleCatalogEntries.length === 0) {
        logger.info('memory consistency check: OK');
        return;
      }

      if (missingFromCatalog.length > 0) {
        logger.warn(`catalog 缺失模块：${missingFromCatalog.join(', ')}`);
      }

      if (staleCatalogEntries.length > 0) {
        logger.warn(`catalog 存在陈旧模块：${staleCatalogEntries.join(', ')}`);
      }
    });
}
