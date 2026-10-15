/** Admission is synchronous; later server failures use the existing chat error surface. */
export function submitMessageDraft(
  disabled: boolean,
  submit: (() => boolean) | undefined,
  onAccepted: () => void
): boolean {
  if (disabled || submit?.() !== true) return false
  onAccepted()
  return true
}
