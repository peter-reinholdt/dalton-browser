// Page-lifetime immutable assets only. Every calculation still gets fresh WASM/FS state.
const engines=new Map(),bases=new Map();
export function supportsRelaxedSIMD(wasm=WebAssembly){
  return wasm.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,8,1,96,3,123,123,123,1,123,3,2,1,0,10,13,1,11,0,32,0,32,1,32,2,253,135,2,11]));
}
export async function loadEngineAssets(parallel=false) {
  const key=parallel?'mpi':'serial',cacheHit=engines.has(key),started=performance.now();
  if(!engines.has(key)) {
    const loading=(async()=>{
      let base=new URL('./assets/',import.meta.url);
      const response=await fetch(new URL('manifest.json',base));
      if(!response.ok)throw Error('Dalton engine assets are missing.');
      let manifest=await response.json();
      if(parallel && !manifest.mpi) {
        // Compatibility with older separately packaged serial/MPI sites.
        base=new URL('./assets/mpi/',import.meta.url);
        const old=await fetch(new URL('manifest.json',base));
        if(!old.ok)throw Error('Dalton MPI engine assets are missing.');
        manifest=await old.json();
      } else if(parallel && manifest.mpi) {
        return loadEngineAssets(false);
      }
      if(manifest.numericalMode==='relaxed-simd'&&!supportsRelaxedSIMD()){
        if(!manifest.conservativeAssets)throw Error('This experimental engine needs relaxed SIMD. Use the conservative build.');
        base=new URL(manifest.conservativeAssets,base);
        const fallback=await fetch(new URL('manifest.json',base));
        if(!fallback.ok)throw Error('The conservative fallback engine is missing.');
        manifest={...await fallback.json(),selectedVariant:'conservative-fallback'};
        if(manifest.numericalMode==='relaxed-simd')throw Error('The fallback must use conservative arithmetic.');
      }
      const basisBase=new URL('./assets/basis/',import.meta.url),basisKey=basisBase.href+JSON.stringify(manifest.basis);
      if(!bases.has(basisKey)) {
        const promise=Promise.all(manifest.basis.map(async name=>{
          const r=await fetch(new URL(encodeURIComponent(name),basisBase));
          if(!r.ok)throw Error(`Could not load basis ${name}`);
          return [name,new Uint8Array(await r.arrayBuffer())];
        })).then(Object.fromEntries);
        bases.set(basisKey,promise);
        promise.catch(()=>bases.delete(basisKey));
      }
      const [wasm,glue,basis]=await Promise.all([
        fetch(new URL('dalton.wasm',base)).then(readBytes),
        fetch(new URL('dalton.mjs',base)).then(readBytes),bases.get(basisKey),
      ]);
      // A deployment during a session must not pair cached WASM with newer glue.
      for(const [bytes,expected] of [[wasm,manifest.wasmSha256],[glue,manifest.glueSha256]])if(expected){
        const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
        if(Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('')!==expected)
          throw Error('Engine files do not match their build manifest. Reload the page to load the updated engine.');
      }
      const compiled=await WebAssembly.compile(wasm);
      return {manifest,compiled,basis,glueSource:new TextDecoder().decode(glue),glueBase:base.href};
    })();
    engines.set(key,loading);loading.catch(()=>engines.delete(key));
  }
  const assets=await engines.get(key);
  return {...assets,loadMs:performance.now()-started,cacheHit:cacheHit||assets.cacheHit||false};
}
async function readBytes(response){if(!response.ok)throw Error('Dalton engine assets are missing.');return response.arrayBuffer();}
export async function importEngine(glueSource,fallbackURL){
  if(!glueSource)return (await import(fallbackURL)).default;
  const url=URL.createObjectURL(new Blob([glueSource],{type:'text/javascript'}));
  try{return (await import(url)).default;}finally{URL.revokeObjectURL(url);}
}
export function instantiateCompiled(compiled,onError) {
  return (imports,success)=>{
    WebAssembly.instantiate(compiled,imports).then(instance=>success(instance,compiled)).catch(onError);
    return {};
  };
}
