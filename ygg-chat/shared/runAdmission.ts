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
