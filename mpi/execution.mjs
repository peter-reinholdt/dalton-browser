import { loadEngineAssets } from '../engine-assets.mjs';
export function executionProfile(settings) {
  if(settings.mode==='expert'||!['HF','DFT'].includes(settings.method))return null;
  return `${settings.method}:${settings.task}:${settings.environment??'gas'}:${Number(settings.multiplicity)===1?'closed':'open'}`;
}
export function mpiAvailability(manifest,scope=globalThis) {
  if(!scope.crossOriginIsolated||typeof scope.SharedArrayBuffer!=='function')return 'This browser needs cross-origin isolation to use MPI. One process remains available.';
  if(typeof scope.Atomics?.wait!=='function')return 'This browser does not support blocking worker synchronization. One process remains available.';
  if(!manifest?.mpi)return 'The MPI engine has not been installed on this site.';
  return null;
}
export function validateExecution(processes,settings,manifest,scope=globalThis) {
  if(!Number.isInteger(processes)||processes<1||processes>8)throw new Error('Choose 1–8 MPI processes.');
  if(processes===1)return null;
  const unavailable=mpiAvailability(manifest,scope);if(unavailable)throw new Error(unavailable);
  const profile=executionProfile(settings);
  if(!profile||!manifest.mpi.capabilities.includes(profile))throw new Error('This calculation is available with one process. Its MPI path has not been validated.');
  if(processes>manifest.mpi.maxProcesses)throw new Error('Process count exceeds the engine limit.');
  return profile;
}
export function memoryEstimate(processes,words) {
  // Work array plus observed runtime/scratch overhead in the acceptance cases;
  // not a claim that the browser can guarantee this allocation or an upper bound.
  return processes*(Number(words)*8+448*1024**2+1024**2);
}
export function executionWorker(processes) {
  const worker=new Worker(new URL(processes>1?'./group-worker.mjs':'../worker.mjs',import.meta.url),{type:'module'});
  const post=worker.postMessage.bind(worker),terminate=worker.terminate.bind(worker);
  let stopping=false,finished=false;
  worker.addEventListener('message',({data})=>{if(data.type==='done'||data.type==='error')finished=true;});
  worker.postMessage=(job,transfer)=>{
    if(job.type==='cancel'){post(job);return;}
    loadEngineAssets(processes>1).then(engineAssets=>{
      if(!stopping)post({...job,engineAssets},transfer);
    }).catch(error=>{
      if(!stopping)worker.dispatchEvent(new MessageEvent('message',{data:{type:'error',text:String(error?.message??error)}}));
    });
  };
  if(processes>1){
    worker.terminate=()=>{
      if(stopping)return;stopping=true;
      if(finished){terminate();return;}
      // The coordinator stays responsive while Dalton is blocked and owns its child workers.
      const timer=setTimeout(terminate,3000);
      const stopped=({data})=>{if(data.type==='cancelled'){clearTimeout(timer);worker.removeEventListener('message',stopped);terminate();}};
      worker.addEventListener('message',stopped);post({type:'cancel'});
    };
  }else worker.terminate=()=>{stopping=true;terminate();};
  return worker;
}
