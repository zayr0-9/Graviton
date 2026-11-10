import { v4 as uuid } from 'uuid'

// uuid uses getRandomValues, which remains available on HTTP LAN origins where
// randomUUID is unavailable. Never use time/Math.random for command identities.
export const newClientId = (): string => uuid()
let documentId: string | undefined
export const getClientId = (): string => documentId ??= newClientId()
