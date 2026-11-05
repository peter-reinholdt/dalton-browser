import { executeJob } from './runtime.mjs';
self.onmessage = async ({ data: job }) => {
  try {
    self.postMessage({ type: 'status', text: 'Loading Dalton and basis files…' });
    const response = await fetch(new URL('./assets/manifest.json', import.meta.url));
    if (!response.ok) throw new Error('Dalton assets are missing. Build the WASM target first.');
    const manifest = await response.json();
    const basis = Object.fromEntries(await Promise.all(manifest.basis.map(async name => {
      const response = await fetch(new URL(`./assets/basis/${encodeURIComponent(name)}`, import.meta.url));
      if (!response.ok) throw new Error(`Could not load basis ${name}`);
      return [name, new Uint8Array(await response.arrayBuffer())];
    })));
    self.postMessage({ type: 'status', text: 'Running locally in your browser' });
    const result = await executeJob(job, { basis, onOutput: (text, source) => self.postMessage({ type: 'output', text, source }) });
    self.postMessage({ type: 'done', result }, result.outputs.map(f => f.data.buffer));
  } catch (error) {
    self.postMessage({ type: 'error', text: String(error?.stack ?? error) });
  }
};
