import { MemoryRouter } from './MemoryRouter.js';
import type { FeatureMemory } from './types.js';

export class FeatureMemoryCatalogCoordinator {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async onFeatureSaved(memory: FeatureMemory): Promise<void> {
    const router = MemoryRouter.forProject(this.projectRoot);
    await router.updateCatalogEntry(memory.name, memory);
  }

  async onFeatureDeleted(moduleName: string): Promise<void> {
    const router = MemoryRouter.forProject(this.projectRoot);
    await router.removeCatalogEntry(moduleName);
  }
}
