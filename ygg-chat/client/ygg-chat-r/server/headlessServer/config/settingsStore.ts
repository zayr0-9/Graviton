// server/headlessServer/config/settingsStore.ts
// One accessor for the host settings store used by gatewayFlags.ts and
// electronAppAuth.ts.
//
// When the server factory configured host capabilities, the injected
// KeyValueStore wins: the Electron adapter wraps the same Conf store the
// desktop app writes (projectName 'ygg-chat-r'), and the standalone CLI wraps
// a JSON file under YGG_DATA_DIR. The direct-Conf fallback keeps legacy
// behavior for code paths and unit tests that run without a configured host.
// Stored key formats (`auth_session`, `gateway.*`, `openai_chatgpt_tokens`)
// are identical through either path.

import Conf from 'conf'
import type { KeyValueStore } from '../../hostCapabilities.js'
import { tryGetHostCapabilities } from '../../serverHost.js'

export function getSettingsStore(): KeyValueStore {
  const injected = tryGetHostCapabilities()?.configStore
  if (injected) return injected

  const store = new Conf({ projectName: 'ygg-chat-r', configFileMode: 0o600 })
  return {
    get: key => store.get(key),
    set: (key, value) => {
      store.set(key, value)
    },
    delete: key => {
      store.delete(key as never)
    },
  }
}
