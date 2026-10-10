import { runNpmScript, runTasks } from './build-tasks.mjs'

// Two build branches at most. Checks within the main branch remain sequential
// to avoid running three memory-heavy TypeScript processes simultaneously.
await runTasks([
  () => runNpmScript('build:electron'),
  () => runNpmScript('build:electron:main'),
])
