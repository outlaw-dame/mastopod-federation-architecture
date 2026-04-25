import { listRegistrations } from "./registry/index.js";
import type { MRFAdminStore } from "./store.js";

export async function ensureDefaultModuleConfigs(
  store: MRFAdminStore,
  now: () => string,
): Promise<void> {
  for (const registration of listRegistrations()) {
    const existing = await store.getModuleConfig(registration.manifest.id);
    if (existing) continue;

    await store.setModuleConfig(registration.manifest.id, {
      enabled: registration.manifest.defaultMode !== "disabled",
      mode: registration.manifest.defaultMode,
      priority: registration.manifest.defaultPriority,
      stopOnMatch: false,
      config: registration.getDefaultConfig(),
      updatedAt: now(),
      updatedBy: "system",
      revision: 0,
    });
  }
}
