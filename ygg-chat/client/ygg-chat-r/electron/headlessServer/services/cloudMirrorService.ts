/**
 * CloudMirrorService — server-side replacement for the renderer's reactive
 * dualSyncManager: mirrors Railway-authoritative cloud entities into local
 * SQLite so the renderer talks only to the local server.
 *
 * Phase 0 SKELETON. Not wired yet. The real upserts (reusing the existing
 * /api/sync/* sink logic) and the CloudMirrorSink message-id adoption land in
 * Phase 4/5. Inert until then.
 */

export type CloudEntityKind =
  | 'user'
  | 'project'
  | 'conversation'
  | 'message'
  | 'attachment'
  | 'provider-cost'

export interface CloudMirrorService {
  /** Upsert a Railway-returned entity into local SQLite (adopting its id). */
  mirror(kind: CloudEntityKind, entity: unknown): Promise<void>
}

class NotImplementedCloudMirrorService implements CloudMirrorService {
  async mirror(_kind: CloudEntityKind, _entity: unknown): Promise<void> {
    throw new Error('CloudMirrorService.mirror is not implemented until Phase 4/5 (cloud gateway).')
  }
}

/** Placeholder factory. Replaced with the real SQLite-mirroring service in Phase 4/5. */
export function createCloudMirrorService(): CloudMirrorService {
  return new NotImplementedCloudMirrorService()
}
