import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
/** Native session header is injected by Electron main, never exposed to renderer
 * JS. It separates opaque native requests from opaque embedded browser apps;
 * it is not device access authentication for reachable network clients. */
export const nativeClientHeader = 'X-Graviton-Native-Session'
const secret = randomBytes(32).toString('hex')
export function getNativeClientFence(): string { return secret }
export function isNativeClientFence(value: unknown): boolean {
  return typeof value === 'string' && value.length === secret.length && timingSafeEqual(Buffer.from(value), Buffer.from(secret))
}
export function opaqueMutationFence(req: Request, res: Response, next: NextFunction): void {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') === 'null' && !isNativeClientFence(req.get(nativeClientHeader))) {
    res.status(403).json({ error: 'Opaque embedded apps must use the parent host bridge' }); return
  }
  next()
}
