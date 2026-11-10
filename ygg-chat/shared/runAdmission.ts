export interface RunAdmissionReceipt {
  operationId: string
  epoch: string
  conversationId: string
  streamId: string
  lineageId: string | null
  parentId: string | null
  disposition: 'started' | 'queued' | 'restarted'
  status: 'accepted' | 'interrupted' | 'rejected'
  outcome?: 'completed' | 'failed' | 'cancelled'
  error?: string
  code?: RunAdmissionErrorCode
}

export type RunAdmissionErrorCode = 'lineage_mismatch' | 'configuration_mismatch' | 'operation_conflict' | 'epoch_mismatch' | 'run_unavailable'

/** Diagnostic-only detail for `lineage_mismatch`; the user-facing message is shared. */
export type AdmissionMismatchReason =
  | 'conversation_missing'
  | 'parent_missing'
  | 'parent_foreign_conversation'
  | 'lineage_missing'
  | 'lineage_foreign_conversation'
  | 'lineage_archived'
  | 'parent_not_on_lineage'
  | 'parent_not_head'
  | 'empty_parent_on_nonempty_conversation'
  | 'unowned_parent_has_children'
  | 'setup_head_advanced'
