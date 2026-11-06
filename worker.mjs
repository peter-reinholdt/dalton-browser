import { executeJob } from './runtime.mjs';
import { instantiateCompiled,importEngine } from './engine-assets.mjs';
self.onmessage = async ({ data: job }) => {
  try {
    self.postMessage({ type: 'status', text: 'Loading Dalton and basis files…' });
    const assets=job.engineAssets;
    const response = assets?null:await fetch(new URL('./assets/manifest.json', import.meta.url));
    if (response&&!response.ok) throw new Error('Dalton assets are missing. Build the WASM target first.');
    const manifest = assets?.manifest??await response.json();
    if (Number(job.workspaceWords ?? 16000000) > (manifest.maxWorkspaceWords ?? 64000000))
      throw new Error('Requested workspace exceeds this build’s supported memory limit.');
    const basis = assets?.basis??Object.fromEntries(
      await Promise.all(
        manifest.basis.map(async (name) => {
          const response = await fetch(
            new URL(`./assets/basis/${encodeURIComponent(name)}`, import.meta.url),
          );
          if (!response.ok) throw new Error(`Could not load basis ${name}`);
          return [name, new Uint8Array(await response.arrayBuffer())];
        }),
      ),
    );
    self.postMessage({ type: 'status', text: 'Running locally in your browser' });
    const result = await executeJob(job, {
      basis,
      createModule:assets?await importEngine(assets.glueSource,new URL('./assets/dalton.mjs',import.meta.url).href):undefined,
      scratchStorage:Boolean(manifest.optimization?.scratchStorage),
      moduleOptions:assets?{locateFile:path=>new URL(path,assets.glueBase).href,
        instantiateWasm:instantiateCompiled(assets.compiled,error=>self.postMessage({type:'error',text:String(error)}))}:{},
      onOutput: (text, source) => self.postMessage({ type: 'output', text, source }),
    });
    result.execution={requestedProcesses:1,effectiveProcesses:1,engine:manifest};
    result.timings.assetsMs=assets?.loadMs??0;
    result.timings.assetsCacheHit=assets?.cacheHit??false;
    result.elapsedMs+=assets?.loadMs??0;
    self.postMessage(
      { type: 'done', result },
      result.outputs.map((f) => f.data.buffer),
    );
  } catch (error) {
    self.postMessage({ type: 'error', text: String(error?.stack ?? error) });
  }
};
