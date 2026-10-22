import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Test-only: Pi does not export its in-memory CredentialStore from the package root.
import { AuthStorage } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { createWebAuthentication } from "../authentication";

export type AuthStorageData = NonNullable<Parameters<typeof AuthStorage.inMemory>[0]>;

/** Real native auth, isolated from user settings, catalogs and credential files. */
export async function nativeAuthFixture(
  options: {
    readonly initial?: AuthStorageData;
    readonly register?: boolean;
    readonly modelsPath?: string | null;
  } = {},
) {
  const storage = AuthStorage.inMemory(options.initial ?? {});
  const runtime = await ModelRuntime.create({
    credentials: storage,
    modelsPath: options.modelsPath ?? null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const authentication = createWebAuthentication();
  const pi: Pick<ExtensionAPI, "registerProvider"> = {
    registerProvider: registry.registerProvider.bind(registry),
  };
  if (options.register !== false) {
    authentication.register(pi, registry);
  }
  return { storage, runtime, registry, authentication, pi };
}

export async function inheritingChild(parent: {
  readonly storage: AuthStorage;
  readonly registry: ModelRegistry;
}) {
  const runtime = await ModelRuntime.create({
    credentials: parent.storage,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  for (const id of parent.registry.getRegisteredProviderIds()) {
    const native = parent.registry.getRegisteredNativeProvider(id);
    const config = parent.registry.getRegisteredProviderConfig(id);
    if (native !== undefined) {
      registry.registerProvider(native);
    } else if (config !== undefined) {
      registry.registerProvider(id, config);
    }
  }
  const authentication = createWebAuthentication();
  const pi: Pick<ExtensionAPI, "registerProvider"> = {
    registerProvider: registry.registerProvider.bind(registry),
  };
  return { storage: parent.storage, runtime, registry, authentication, pi };
}
