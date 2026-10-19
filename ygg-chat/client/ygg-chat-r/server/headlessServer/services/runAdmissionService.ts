import { resolveHostModePromptDefaults } from './hostModePromptDefaults.js'
import type { HostExecutionPreferences } from '../../../../../shared/hostExecutionPreferences.js'
import { randomUUID } from 'node:crypto'
import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import type { QueuedMessageSubmission } from '../../../../../shared/queuedMessages.js'
import type { RunAdmissionReceipt } from '../../../../../shared/runAdmission.js'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors.js'
import { OperationReceiptRepo, operationFingerprint } from '../persistence/operationReceiptRepo.js'
import type { HeadlessChatOrchestrator } from './chatOrchestrator.js'
import type { RunSessionRegistry } from './runSessionRegistry.js'

/** Admission is synchronous through reservation/receipt/engine registration. No
 * await may be introduced before runMessage registers its mailbox. */
export class RunAdmissionService {
  constructor(private deps: { epoch: string; receipts: OperationReceiptRepo; orchestrator: HeadlessChatOrchestrator; sessions: RunSessionRegistry; executionDefaults?: () => HostExecutionPreferences }) {
    deps.receipts.interruptPreviousEpoch(deps.epoch)
  }

  lookup(operationId: string): RunAdmissionReceipt | null { return this.deps.receipts.get(operationId)?.receipt ?? null }

  admit(request: HeadlessMessageRequest, epoch: string): RunAdmissionReceipt {
    const { receipts, orchestrator, sessions } = this.deps
    const operationId = request.operationId
    if (!operationId || operationId.length > 128) throw new Error('A stable operationId is required')
    // These legacy authentication fields are not part of the public command and
    // are never stored. All effective execution settings/attachments are hashed.
    const { accessToken: _token, accountId: _account, ...publicRequest } = request
    const fingerprint = operationFingerprint(publicRequest)
    const existing = receipts.get(operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('Operation ID already used for another request'), { code: 'operation_conflict' })
      return existing.receipt
    }
    if (epoch !== this.deps.epoch) throw Object.assign(new Error('The host restarted. Reconcile before sending a new command.'), { code: 'epoch_mismatch' })
    if (!orchestrator.classifyOrdinarySend || !orchestrator.submitQueuedMessage) throw new Error('Admission unavailable')
    const ordinary = request.operation === 'send' && !request.manualCompaction && !request.retrigger && !request.isBranch
    const target = ordinary || request.manualCompaction ? orchestrator.classifyOrdinarySend(request) : { lineageId: null, parentId: request.parentId }
    if (request.manualCompaction && target.activeStreamId) throw Object.assign(new Error('Wait for this branch run to finish before compacting'), { code: 'run_unavailable' })
    if (request.streamId && sessions.get(request.streamId) && !target.activeStreamId) {
      throw Object.assign(new Error('Stream ID already belongs to another command'), { code: 'operation_conflict' })
    }
    const receipt: RunAdmissionReceipt = { operationId, epoch, conversationId: request.conversationId,
      streamId: target.activeStreamId ?? request.streamId ?? randomUUID(), lineageId: target.lineageId,
      parentId: target.parentId, disposition: target.activeStreamId ? 'queued' : 'started', status: 'accepted' }
    // Crash after this point is uncertain, not permission to execute again.
    receipts.insert(fingerprint, receipt)
    try {
      if (target.activeStreamId) {
        const result = orchestrator.submitQueuedMessage(request.conversationId, target.activeStreamId, {
          requestId: operationId, content: request.content, attachmentsBase64: request.attachmentsBase64, selectedFiles: request.selectedFiles,
          fullAccess: request.fullAccess === true, fullAccessNotificationId: request.fullAccessNotificationId,
        })
        receipt.lineageId = result.snapshot?.lineageId ?? receipt.lineageId
        if (result.restart) {
          receipt.streamId = result.restart.streamId!
          receipt.parentId = result.restart.parentId
          receipt.disposition = 'restarted'
          receipts.update(receipt)
          this.launch(result.restart)
        } else if (result.restartStreamId) {
          receipt.streamId = result.restartStreamId
          receipt.disposition = 'restarted'
        }
        receipts.update(receipt)
      } else {
        const defaults = this.deps.executionDefaults?.()
        const modePrompts = defaults ? resolveHostModePromptDefaults(defaults.modePrompts) : undefined
        this.launch({ ...request,
          operationModePrompt: request.operationModePrompt ?? modePrompts?.operationModePrompt,
          subagentModePrompt: request.subagentModePrompt ?? modePrompts?.subagentSystemPrompt,
          subagentDefaults: defaults ? { ...defaults.subagent, enabledTools: defaults.subagent.enabledTools.filter(name => defaults.tools[name] !== false && !name.startsWith('mcp__')) } : undefined,
          subagentReasoningEffort: request.subagentReasoningEffort ?? defaults?.subagent.reasoningEffort,
          toolTimeoutMs: request.toolTimeoutMs ?? defaults?.toolTimeouts.toolCallTimeoutMs,
          bashTimeoutMs: request.bashTimeoutMs ?? defaults?.toolTimeouts.bashTimeoutMs,
          toolAutoApprove: request.toolAutoApprove ?? defaults?.toolAutoApprove,
          autoCompactionEnabled: request.autoCompactionEnabled ?? defaults?.autoCompactionEnabled,
          contextDirectories: request.contextDirectories ?? defaults?.contextDirectories,
          autoMemoryEnabled: request.autoMemoryEnabled ?? defaults?.longTermMemoryContextEnabled,
          planModeVerbosity: request.planModeVerbosity ?? defaults?.planModeVerbosity,
          compactionThresholdPercent: request.compactionThresholdPercent ?? defaults?.provider.compactionThresholdPercent,
          compactionProvider: request.compactionProvider ?? defaults?.provider.compactionProvider,
          compactionModelName: request.compactionModelName ?? defaults?.provider.compactionModel,
          compactionSystemPrompt: request.compactionSystemPrompt ?? defaults?.provider.compactionSystemPrompt,
          streamId: receipt.streamId, ...(target.lineageId ? { lineageId: target.lineageId } : {}) })
      }
      return receipts.get(operationId)?.receipt ?? receipt
    } catch (error) {
      receipt.status = 'rejected'
      receipt.code = (error as any)?.code
      receipt.error = error instanceof Error ? error.message : 'Admission rejected'
      receipts.update(receipt)
      throw error
    }
  }

  enqueue(conversationId: string, streamId: string, submission: QueuedMessageSubmission, epoch: string) {
    const { receipts, orchestrator } = this.deps
    const fingerprint = operationFingerprint({ kind: 'queue', conversationId, streamId, submission })
    const existing = receipts.get(submission.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('Operation ID already used for another request'), { code: 'operation_conflict' })
      if (existing.receipt.status !== 'accepted') throw Object.assign(new Error(existing.receipt.error || 'Previous command interrupted'), { code: existing.receipt.code })
      let snapshot
      try { snapshot = orchestrator.getMessageQueue?.(conversationId, existing.receipt.streamId) } catch { /* Receipt outlives mailbox. */ }
      return { receipt: existing.receipt, snapshot, streamId: existing.receipt.streamId, restarted: existing.receipt.disposition === 'restarted', parentId: existing.receipt.parentId }
    }
    if (epoch !== this.deps.epoch) throw Object.assign(new Error('The host restarted. Reconcile before sending.'), { code: 'epoch_mismatch' })
    if (!orchestrator.submitQueuedMessage) throw new Error('Queue unavailable')
    const receipt: RunAdmissionReceipt = { operationId: submission.requestId, epoch, conversationId, streamId,
      lineageId: null, parentId: null, disposition: 'queued', status: 'accepted' }
    receipts.insert(fingerprint, receipt)
    try {
      const result = orchestrator.submitQueuedMessage(conversationId, streamId, submission)
      receipt.lineageId = result.snapshot?.lineageId ?? null
      if (result.restart || result.restartStreamId) {
        receipt.disposition = 'restarted'
        receipt.streamId = result.restart?.streamId ?? result.restartStreamId!
        receipt.parentId = result.restart?.parentId ?? null
      }
      receipts.update(receipt)
      if (result.restart) this.launch(result.restart)
      return { receipt, snapshot: result.snapshot, streamId: receipt.streamId, restarted: receipt.disposition === 'restarted', parentId: receipt.parentId }
    } catch (error) {
      receipt.status = 'rejected'; receipt.error = error instanceof Error ? error.message : 'Queue rejected'; receipt.code = (error as any)?.code
      receipts.update(receipt)
      throw error
    }
  }

  private launch(request: HeadlessMessageRequest): void {
    const session = this.deps.sessions.createMain(request.streamId!, request.conversationId)
    session.effectiveConfiguration = { provider: request.provider, modelName: request.modelName,
      fullAccess: request.fullAccess === true, toolAutoApprove: request.toolAutoApprove !== false,
      operationMode: request.operationMode === 'plan' ? 'plan' : 'execute' }
    const emit = (event: HeadlessStreamEvent) => session.publish(event)
    void this.deps.orchestrator.runMessage(request, emit, session.signal).catch(error => {
      if (!(error as any)?.chatErrorPublished) emit({ type: 'error', terminal: true, error: 'Run failed during setup',
        envelope: buildChatErrorEnvelope('internal_error') })
    })
  }
}
