// server/server/nodeStores.ts
// Plain-Node implementations of the host stores for the standalone server.
//
// The config store is one JSON file under the data directory with Conf-style
// dotted-path keys ('gateway.chat' reads/writes {gateway:{chat}}), so the
// key formats shared with the desktop app keep working. The secret store uses
// the same file under a 'secrets' subtree; the file is chmod 0600.

import fs from 'fs'
import path from 'path'
import type { KeyValueStore, SecretStore } from './hostCapabilities.js'

const STORE_FILE_MODE = 0o600

type JsonObject = Record<string, unknown>

function readJsonFile(filePath: string): JsonObject {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {}
  } catch {
    return {}
  }
}

function writeJsonFile(filePath: string, data: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: STORE_FILE_MODE })
}

function getPath(data: JsonObject, dottedKey: string): unknown {
  const segments = dottedKey.split('.')
  let current: unknown = data
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as JsonObject)[segment]
  }
  return current
}

function setPath(data: JsonObject, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split('.')
  let current: JsonObject = data
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[segment] = {}
    }
    current = current[segment] as JsonObject
  }
  current[segments[segments.length - 1]] = value
}

function deletePath(data: JsonObject, dottedKey: string): void {
  const segments = dottedKey.split('.')
  let current: unknown = data
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return
    current = (current as JsonObject)[segments[i]]
  }
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    delete (current as JsonObject)[segments[segments.length - 1]]
  }
}

export function createNodeFileConfigStore(filePath: string): KeyValueStore {
  return {
    get: key => getPath(readJsonFile(filePath), key),
    set: (key, value) => {
      const data = readJsonFile(filePath)
      setPath(data, key, value)
      writeJsonFile(filePath, data)
    },
    delete: key => {
      const data = readJsonFile(filePath)
      deletePath(data, key)
      writeJsonFile(filePath, data)
    },
  }
}

export function createNodeFileSecretStore(filePath: string): SecretStore {
  const store = createNodeFileConfigStore(filePath)
  const prefixed = (key: string) => `secrets.${key}`
  return {
    getSecret: async key => {
      const value = store.get(prefixed(key))
      return typeof value === 'string' ? value : null
    },
    setSecret: async (key, value) => {
      store.set(prefixed(key), value)
    },
    deleteSecret: async key => {
      store.delete(prefixed(key))
    },
  }
}
