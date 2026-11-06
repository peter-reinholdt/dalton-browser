import { OP, MPICoordinator, CHUNK_BYTES, MAX_PENDING_BYTES } from './protocol.mjs';
const collective=new Set([1,2,5,6,7,8,16,17,18,19,20]);
export function createMailbox(){return new SharedArrayBuffer(64+CHUNK_BYTES);}
// Called synchronously from a WASM import. Only this worker blocks.
export class MPIBridge {
  constructor(port,mailbox,profile=false){this.port=port;this.control=new Int32Array(mailbox,0,16);this.payload=new Uint8Array(mailbox,64);this.sequences=new Map();this.profile=profile;this.timings={calls:0,blockedMs:0,roundTripMs:0};}
  call(op,args,data,capacity){
    const started=this.profile?performance.now():0;
    if(capacity<0||capacity>MAX_PENDING_BYTES)throw new Error('Invalid MPI receive capacity');
    const sequence=collective.has(op)?(this.sequences.get(args[0])??0):0;
    if(collective.has(op))this.sequences.set(args[0],sequence+1);
    this.port.postMessage({op,args,data,sequence},[data.buffer]);
    let result,offset=0,meta;
    do{
      while(Atomics.load(this.control,0)===0){
        const waiting=this.profile?performance.now():0;
        Atomics.wait(this.control,0,0);
        if(this.profile)this.timings.blockedMs+=performance.now()-waiting;
      }
      const length=Atomics.load(this.control,1),total=Atomics.load(this.control,2),done=Atomics.load(this.control,3);
      if(total>capacity||length<0||length>this.payload.length||offset+length>total)throw new Error('MPI reply exceeds receive capacity');
      result??=new Uint8Array(total);result.set(this.payload.subarray(0,length),offset);offset+=length;
      meta=Array.from(this.control.subarray(4,12));
      Atomics.store(this.control,0,0);this.port.postMessage({ack:true});
      if(done){if(offset!==total)throw new Error('Incomplete MPI reply');break;}
    }while(true);
    if(this.profile){this.timings.calls++;this.timings.roundTripMs+=performance.now()-started;}
    return {data:result,meta};
  }
}
// Coordinator side: chunked replies, paced by acknowledgements. Never waits.
export class MPIReplyChannel {
  constructor(mailbox){this.control=new Int32Array(mailbox,0,16);this.payload=new Uint8Array(mailbox,64);this.queue=[];this.active=null;}
  send(result){this.queue.push({result,offset:0});this.pump();}
  ack(){if(!this.active)throw new Error('Unexpected MPI reply acknowledgement');if(this.active.finished)this.active=null;this.pump();}
  pump(){
    if(Atomics.load(this.control,0)!==0)return;
    this.active??=this.queue.shift();if(!this.active)return;
    const item=this.active,{data,meta}=item.result;
    const chunk=data.subarray(item.offset,item.offset+CHUNK_BYTES);item.offset+=chunk.length;item.finished=item.offset===data.length;
    this.payload.set(chunk);this.control[1]=chunk.length;this.control[2]=data.length;this.control[3]=Number(item.finished);this.control.set(meta,4);
    Atomics.store(this.control,0,1);Atomics.notify(this.control,0);
  }
}

// One MPI process runs synchronously in an ordinary Worker, including on sites
// without SharedArrayBuffer. Use the same protocol and communicator semantics.
export class LocalMPIBridge {
  constructor() {
    this.result=null;
    this.sequences=new Map();
    this.coordinator=new MPICoordinator(1,(_rank,result)=>{this.result=result;});
  }
  call(op,args,data,capacity) {
    this.result=null;
    const sequence=collective.has(op)?(this.sequences.get(args[0])??0):0;
    if(collective.has(op))this.sequences.set(args[0],sequence+1);
    this.coordinator.receive(0,{op,args,data,sequence});
    if(!this.result)throw new Error('One-process MPI encountered an unmatched blocking receive');
    if(this.result.data.length>capacity)throw new Error('MPI reply exceeds receive capacity');
    return this.result;
  }
}
