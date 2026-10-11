// The Monaco-bound modules behind the lazy boundary in ./monacoWorkspace.ts. Import
// them through loadMonacoWorkspace() only; a static import from eager code would pull
// monaco-editor back into the startup bundle.
export { MonacoFileEditorPane } from '../MonacoFileEditorPane/MonacoFileEditorPane'
export { MonacoGitDiffPane } from '../MonacoGitDiffPane/MonacoGitDiffPane'
export { lspClientPool } from '../../lib/lsp/lspClientPool'
export { onTrackedModelContentChange, releaseModel, retainModel, setModelContent } from '../../lib/lsp/modelRegistry'
