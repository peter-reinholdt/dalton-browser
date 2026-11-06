import { MPICoordinator, MPI_RUNTIME } from './protocol.mjs';
import { createMailbox, MPIReplyChannel } from './bridge.mjs';
import { validateJob } from '../runtime.mjs';
const ranks=[],ports=[];
let finished=false,startTimer,activeManifest,activeProcesses=0,activeCoordinator,groupStarted=performance.now();
const rankResults=new Map();
function cleanup(){clearTimeout(startTimer);for(const rank of ranks)rank.terminate();for(const port of ports)port.close();}
function fail(text){
  if(finished)return;finished=true;cleanup();
  if(!ranks.length){self.postMessage({type:'error',text});return;}
  const root=rankResults.get(0)??{outputs:[],omitted:[],scratchBytes:0,wasmMemoryBytes:null};
  if(!root.outputs.some(f=>f.name==='DALTON.OUT')&&logs[0].text)root.outputs.push({name:'DALTON.OUTPUT-TAIL.txt',data:new TextEncoder().encode(logs[0].text)});
  const result={...root,exitCode:1,failure:text,outputTail:logs[0].text,elapsedMs:performance.now()-groupStarted,
    rankLogs:logs.slice(0,activeProcesses),execution:{requestedProcesses:activeProcesses,effectiveProcesses:activeProcesses,runtime:MPI_RUNTIME,engine:activeManifest,
      ranks:Array.from({length:activeProcesses},(_,rank)=>({rank,wasmMemoryBytes:rankResults.get(rank)?.wasmMemoryBytes??null,...activeCoordinator?.stats[rank]}))}};
  self.postMessage({type:'done',result},result.outputs.map(f=>f.data.buffer));
}
self.onmessage=async({data:job})=>{
  if(job.type==='cancel'){
    finished=true;cleanup();
    self.postMessage({type:'cancelled',rankLogs:logs.slice(0,activeProcesses),
      ranks:Array.from({length:ranks.length},(_,rank)=>({rank,...activeCoordinator?.stats[rank]}))});
    return;
  }
  try {
    validateJob(job);
    if(!self.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('MPI needs cross-origin isolation. Choose one process for serial execution.');
    const processes=job.processes;groupStarted=performance.now()-(job.engineAssets?.loadMs??0);
    if(!Number.isInteger(processes)||processes<2||processes>8)throw new Error('Choose 2–8 MPI processes');
    self.postMessage({type:'status',text:`Loading ${processes} MPI processes…`});
    const response=job.engineAssets?null:await fetch(new URL('../assets/manifest.json',import.meta.url));
    if(response&&!response.ok)throw new Error('MPI engine assets are missing');
    const manifest=job.engineAssets?.manifest??await response.json();
    activeManifest=manifest;activeProcesses=processes;
    if(job.workspaceWords>manifest.maxWorkspaceWords)throw new Error('Work memory exceeds the MPI engine limit');
    const profile=job.executionProfile;
    const dal=typeof job.files[job.dal]==='string'?job.files[job.dal]:new TextDecoder().decode(job.files[job.dal]);
    if(/\.RMA-MD/i.test(dal))throw new Error('Remote-memory mode is unavailable in browser MPI');
    if(!profile||!manifest.mpi.capabilities.includes(profile))throw new Error('This calculation is not validated for MPI. Choose one process.');
    const [compiled,basis]=job.engineAssets?[job.engineAssets.compiled,job.engineAssets.basis]:await Promise.all([
      fetch(new URL('../assets/dalton.wasm',import.meta.url)).then(async r=>{if(!r.ok)throw new Error('Missing MPI WASM');return WebAssembly.compile(await r.arrayBuffer());}),
      Promise.all(manifest.basis.map(async name=>{const r=await fetch(new URL(`../assets/basis/${encodeURIComponent(name)}`,import.meta.url));if(!r.ok)throw new Error(`Missing basis ${name}`);return [name,new Uint8Array(await r.arrayBuffer())];})).then(Object.fromEntries),
    ]);
    if(finished)return;
    const ready=new Set(),results=rankResults,channels=[];const started=groupStarted;
    const assetsReady=performance.now();let ranksReady=assetsReady;
    const coordinator=new MPICoordinator(processes,(rank,result)=>channels[rank].send(result));activeCoordinator=coordinator;
    startTimer=setTimeout(()=>fail('MPI processes did not finish initialization within 90 seconds'),90000);
    for(let rank=0;rank<processes;rank++) {
      const mailbox=createMailbox(),channel=new MessageChannel(),worker=new Worker(new URL('./rank-worker.mjs',import.meta.url),{type:'module'});
      ranks.push(worker);ports.push(channel.port1);channels.push(new MPIReplyChannel(mailbox));
      channel.port1.onmessage=({data})=>{if(finished)return;try{if(data.ack)channels[rank].ack();else coordinator.receive(rank,data);}catch(e){fail(`MPI rank ${rank}: ${e.message}`);}};
      worker.onerror=e=>fail(`MPI rank ${rank}: ${e.message}`);
      worker.onmessage=({data})=>{
        if(finished)return;
        if(data.type==='ready'){
          ready.add(rank);if(ready.size===processes){ranksReady=performance.now();clearTimeout(startTimer);for(const w of ranks)w.postMessage({type:'go'});self.postMessage({type:'status',text:`Running with ${processes} MPI processes`});}
        }else if(data.type==='output'){
          // Root is the scientific output. Keep other rank streams available for diagnosis.
          const entry=logs[rank];entry.text=(entry.text+data.text).slice(rank===0?-262144:-65536);
          if(rank===0)self.postMessage(data);
        }else if(data.type==='error')fail(`MPI rank ${rank}: ${data.text}`);
        else if(data.type==='rank-done'){
          results.set(rank,data.result);
          if(data.result.exitCode){
            const output=data.result.outputs.find(file=>file.name.startsWith('DALTON.OUT'));
            const text=output?new TextDecoder().decode(output.data):(data.result.outputTail??'');
            const reason=text.match(/^\s*@?\s*Reason(?: for quit)?:\s*(.+)$/m)?.[1];
            return fail(`MPI rank ${rank}: ${reason??data.result.failure??'Dalton reported a failure'}`);
          }
          if(results.size===processes){
            const result=results.get(0);result.elapsedMs=performance.now()-started;
            result.timings={...result.timings,assetsMs:assetsReady-started,assetsCacheHit:job.engineAssets?.cacheHit??false,groupStartupMs:ranksReady-assetsReady};
            result.execution={requestedProcesses:processes,effectiveProcesses:processes,runtime:MPI_RUNTIME,engine:manifest,
              ranks:Array.from(results,([rank,r])=>({rank,wasmMemoryBytes:r.wasmMemoryBytes,scratchBytes:r.scratchBytes,fileStorageBytes:r.fileStorageBytes,mpiTimings:r.mpiTimings,...coordinator.stats[rank]})).sort((a,b)=>a.rank-b.rank)};
            result.scratchBytes=Array.from(results.values()).reduce((sum,r)=>sum+r.scratchBytes,0);
            result.fileStorageBytes=Array.from(results.values()).reduce((sum,r)=>sum+(r.fileStorageBytes??0),0);
            result.rankLogs=logs.filter(l=>l.rank!==0&&l.text);
            cleanup();finished=true;self.postMessage({type:'done',result},result.outputs.map(f=>f.data.buffer));
          }
        }
      };
      const {engineAssets,...rankJob}=job;
      worker.postMessage({type:'rank',rank,job:rankJob,basis,port:channel.port2,mailbox,compiled,
        glueSource:job.engineAssets?.glueSource,glueBase:job.engineAssets?.glueBase,
        scratchStorage:Boolean(manifest.optimization?.scratchStorage)},[channel.port2]);
    }
  }catch(error){fail(String(error?.stack??error));}
};
const logs=Array.from({length:8},(_,rank)=>({rank,text:''}));
