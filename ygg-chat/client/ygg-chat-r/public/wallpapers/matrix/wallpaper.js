import makeConfig from './js/config.js';
import startRenderer from './js/regl/main.js';

// Only these presets/parameters are accepted. No camera, remote media or arbitrary effects.
const params = new URLSearchParams(location.search);
const finite = (name, fallback, min, max) => {
  const value = Number(params.get(name) ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
const preset = ['classic', 'resurrections', 'operator'].includes(params.get('preset')) ? params.get('preset') : 'classic';
const config = makeConfig({
  version: preset,
  fps: String(finite('fps', 30, 15, 60)),
  animationSpeed: String(finite('speed', 1, 0.25, 2)),
  numColumns: String(Math.round(finite('columns', { classic: 80, resurrections: 70, operator: 108 }[preset], 20, 120))),
  resolution: '0.5',
});
const canvas = document.querySelector('canvas');
let renderer;
let parentPaused = true;
let disposed = false;
let failed = false;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const notify = status => parent.postMessage({ type: 'graviton:matrix-status', status }, '*');
const sync = () => renderer?.setPaused(parentPaused || document.hidden || motion.matches || failed);
const fail = () => {
  if (failed) return;
  failed = true;
  renderer?.destroy();
  renderer = null;
  canvas.style.visibility = 'hidden';
  notify('error');
};
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'graviton:matrix-pause' || typeof event.data.paused !== 'boolean') return;
  parentPaused = event.data.paused;
  sync();
});
document.addEventListener('visibilitychange', sync);
motion.addEventListener('change', sync);
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(); });
window.addEventListener('error', fail);
window.addEventListener('unhandledrejection', fail);
window.addEventListener('pagehide', () => { disposed = true; renderer?.destroy(); renderer = null; });
try {
  renderer = await startRenderer(canvas, config);
  if (disposed || failed) { renderer.destroy(); renderer = null; }
  else { sync(); notify('ready'); }
} catch {
  fail();
}
