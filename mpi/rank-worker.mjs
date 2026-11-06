import { executeJob } from '../runtime.mjs';
import { MPIBridge } from './bridge.mjs';
import { importEngine } from '../engine-assets.mjs';
let start;
const go=new Promise(resolve=>start=resolve);
self.onmessage=async({data})=>{
  if(data.type==='go'){start();return;}
  if(data.type!=='rank')return;
  const {rank,job,basis,port,mailbox,compiled,scratchStorage,glueSource,glueBase}=data;
  try {
    const createModule=await importEngine(glueSource,new URL('../assets/dalton.mjs',import.meta.url).href);
    const bridge=new MPIBridge(port,mailbox,Boolean(job.profileCommunication));
    const result=await executeJob(job,{
      createModule,basis,scratchStorage,
      moduleOptions:{mpiBridge:bridge,
        ...(glueBase?{locateFile:path=>new URL(path,glueBase).href}:{}),
        instantiateWasm(imports,success){WebAssembly.instantiate(compiled,imports).then(instance=>success(instance,compiled)).catch(error=>self.postMessage({type:'error',rank,text:String(error)}));return {}; }},
      beforeMain:async()=>{self.postMessage({type:'ready',rank});await go;},
      onOutput:(text,source)=>self.postMessage({type:'output',rank,text,source}),
      outputPattern:rank===0?null:/^DALTON\.OUT(?:\.n\d+)?$/,
    });
    if(job.profileCommunication)result.mpiTimings=bridge.timings;
    self.postMessage({type:'rank-done',rank,result},result.outputs.map(f=>f.data.buffer));
  }catch(error){self.postMessage({type:'error',rank,text:String(error?.stack??error)});}
};
