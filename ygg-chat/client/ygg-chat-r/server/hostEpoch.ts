import { randomUUID } from 'node:crypto'

/** One process incarnation, shared by bootstrap, receipts and restart outcomes. */
export const hostEpoch = randomUUID()
