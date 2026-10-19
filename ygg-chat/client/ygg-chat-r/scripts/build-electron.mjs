import { runNpmScript, runTasks } from './build-tasks.mjs'

// Two build branches at most. Checks within the main branch remain sequential
// to avoid running three memory-heavy TypeScript processes simultaneously.
await runTasks([
  async () => {
    await runNpmScript('build:electron')
    await runNpmScript('build:browser-client')
  },
  () => runNpmScript('build:electron:main'),
])
