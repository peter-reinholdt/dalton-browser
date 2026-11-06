// Transport ABI v1. Kept independent of DOM/Workers for protocol tests.
export const OP = Object.freeze({ INIT:1, FINALIZE:2, RANK:3, SIZE:4, SPLIT:5,
  FREE:6, BARRIER:7, BCAST:8, SEND:9, RECV:10, ISEND:11, IRECV:12, WAIT:13,
  TEST:14, PROBE:15, REDUCE:16, ALLREDUCE:17, GATHER:18, ALLGATHER:19, SCATTER:20 });
export const CHUNK_BYTES = 1024 * 1024;
export const MAX_PENDING_BYTES = 256 * 1024 ** 2;
export const MPI_RUNTIME = 'dalton-browser-mpi-1';
const collectiveOps = new Set([1,2,5,6,7,8,16,17,18,19,20]);
const typeSizes = {1:4,2:8,3:8,4:4,5:1};
const empty = () => new Uint8Array();
function join(arrays) {
  const out = new Uint8Array(arrays.reduce((sum,a)=>sum+a.length,0));
  let offset=0; for(const a of arrays){out.set(a,offset);offset+=a.length;} return out;
}
function reduction(items, type, operation) {
  const constructors={1:Int32Array,2:BigInt64Array,3:Float64Array,4:Float32Array,5:Uint8Array};
  const T=constructors[type]; if(!T || ![1,2,3,4,5,6].includes(operation))throw new Error('Unsupported MPI reduction');
  const out=new T(items[0].slice().buffer);
  for(const item of items.slice(1)) {
    if(item.length!==out.byteLength)throw new Error('MPI reduction count mismatch');
    const values=new T(item.slice().buffer);
    for(let i=0;i<out.length;i++) {
      const a=out[i],b=values[i],big=type===2;
      switch(operation){case 1:out[i]=a+b;break;case 2:out[i]=a>b?a:b;break;
        case 3:out[i]=a<b?a:b;break;case 4:out[i]=a*b;break;
        case 5:out[i]=big?BigInt(!!a&&!!b):Number(!!a&&!!b);break;
        case 6:out[i]=big?BigInt(!!a||!!b):Number(!!a||!!b);break;}
    }
  }
  return new Uint8Array(out.buffer);
}
export class MPICoordinator {
  constructor(size, reply) {
    if(!Number.isInteger(size)||size<1||size>8)throw new Error('Choose 1–8 MPI processes');
    this.size=size;this.reply=reply;this.comms=new Map([[1,Array.from({length:size},(_,i)=>i)]]);
    this.collectives=new Map();this.messages=[];this.receivers=[];this.requests=new Map();
    this.nextComm=2;this.nextRequest=1;this.pendingBytes=0;this.stats=Array.from({length:size},()=>({calls:0,sentBytes:0,receivedBytes:0}));
  }
  members(comm,rank) {const group=this.comms.get(comm);if(!group?.includes(rank))throw new Error(`Rank ${rank}: invalid communicator ${comm}`);return group;}
  respond(rank,data=empty(),meta=[]) {this.stats[rank].receivedBytes+=data.length;this.reply(rank,{data,meta:[...meta,...Array(8).fill(0)].slice(0,8)});}
  receive(rank, packet) {
    const {op,args:a,sequence=0}=packet,payload=packet.data??empty();
    if(!Array.isArray(a)||a.length!==8||!a.every(Number.isSafeInteger))throw new Error('Invalid MPI arguments');
    if(!(payload instanceof Uint8Array)||payload.length>MAX_PENDING_BYTES)throw new Error('Invalid MPI payload');
    const [comm,peer,tag,count,type,,aux]=a,group=this.members(comm,rank);
    this.stats[rank].calls++;this.stats[rank].sentBytes+=payload.length;
    if(op===OP.RANK)return this.respond(rank,empty(),[group.indexOf(rank)]);
    if(op===OP.SIZE)return this.respond(rank,empty(),[group.length]);
    if(collectiveOps.has(op)) {
      const key=`${comm}:${sequence}`;
      let c=this.collectives.get(key);
      if(!c){c={op,group,packets:new Map()};this.collectives.set(key,c);}
      if(c.op!==op||c.packets.has(rank))throw new Error('Mismatched MPI collective sequence');
      this.reserve(payload.length);c.packets.set(rank,{a,data:payload});
      if(c.packets.size===group.length){this.collectives.delete(key);this.pendingBytes-=Array.from(c.packets.values()).reduce((s,p)=>s+p.data.length,0);this.collective(c);}
      return;
    }
    if([OP.SEND,OP.ISEND].includes(op)) {
      if(peer===-2){if(op===OP.ISEND){const id=this.nextRequest++;this.requests.set(id,{rank,done:true,data:empty(),meta:[]});return this.respond(rank,empty(),[id]);}return this.respond(rank);}
      if(!Number.isInteger(peer)||!group[peer]&&group[peer]!==0||tag<0)throw new Error('Invalid MPI destination/tag');
      if(payload.length!==count*typeSizes[type])throw new Error('MPI send size mismatch');
      this.reserve(payload.length);this.messages.push({comm,src:rank,dest:group[peer],tag,data:payload});this.progress();
      if(op===OP.ISEND){const id=this.nextRequest++;this.requests.set(id,{rank,done:true,data:empty(),meta:[]});this.respond(rank,empty(),[id]);}
      else this.respond(rank);
      return;
    }
    if([OP.RECV,OP.IRECV,OP.PROBE].includes(op)) {
      if(peer!==-1&&peer!==-2&&!group.includes(group[peer]))throw new Error('Invalid MPI source');
      const q={rank,comm,src:peer===-1?-1:peer===-2?-2:group[peer],tag,capacity:count*typeSizes[type],group};
      if(op===OP.PROBE){const msg=this.messages.find(m=>this.matches(q,m));return this.respond(rank,empty(),msg?[1,group.indexOf(msg.src),msg.tag,msg.data.length]:[0]);}
      if(peer===-2){if(op===OP.RECV)return this.respond(rank,empty(),[1,-2,-1,0]);}
      if(op===OP.IRECV){q.id=this.nextRequest++;q.done=peer===-2;q.data=empty();q.meta=[1,-2,-1,0];this.requests.set(q.id,q);if(!q.done)this.receivers.push(q);this.respond(rank,empty(),[q.id]);}
      else this.receivers.push(q);
      this.progress();return;
    }
    if(op===OP.WAIT||op===OP.TEST) {
      const q=this.requests.get(peer);if(!q||q.rank!==rank)throw new Error('Invalid MPI request');
      if(q.done){this.requests.delete(peer);this.pendingBytes-=q.data.length;this.respond(rank,q.data,[1,...q.meta.slice(1)]);}
      else if(op===OP.TEST)this.respond(rank,empty(),[0]);
      else q.waiting=true;
      return;
    }
    throw new Error(`Unsupported MPI operation ${op}`);
  }
  reserve(bytes){if(this.pendingBytes+bytes>MAX_PENDING_BYTES)throw new Error('MPI pending messages exceed 256 MiB; reduce the calculation size');this.pendingBytes+=bytes;}
  matches(q,m){return m.comm===q.comm&&m.dest===q.rank&&(q.src===-1||m.src===q.src)&&(q.tag===-1||m.tag===q.tag);}
  progress(){
    for(let i=0;i<this.receivers.length;) {
      const q=this.receivers[i],index=this.messages.findIndex(m=>this.matches(q,m));
      if(index<0){i++;continue;}
      const [m]=this.messages.splice(index,1);this.receivers.splice(i,1);
      if(m.data.length>q.capacity)throw new Error('MPI receive buffer is too small');
      const meta=[1,q.group.indexOf(m.src),m.tag,m.data.length];
      if(q.id){q.done=true;q.data=m.data;q.meta=meta;if(q.waiting){this.requests.delete(q.id);this.pendingBytes-=m.data.length;this.respond(q.rank,q.data,meta);}}
      else {this.pendingBytes-=m.data.length;this.respond(q.rank,m.data,meta);}
    }
  }
  collective(c){
    const {group,op,packets}=c,items=group.map(r=>packets.get(r));
    const a=items[0].a,[,root,,count,type,reductionOp,receiveBytes]=a;
    if(op===OP.SPLIT){
      const colors=new Map();
      for(const rank of group){const [,color,key]=packets.get(rank).a;if(color===-32766){this.respond(rank,empty(),[0]);continue;}if(color<0)throw new Error('Invalid MPI communicator color');const list=colors.get(color)??[];list.push({rank,key});colors.set(color,list);}
      for(const list of colors.values()){list.sort((a,b)=>a.key-b.key||group.indexOf(a.rank)-group.indexOf(b.rank));const id=this.nextComm++;this.comms.set(id,list.map(x=>x.rank));for(let i=0;i<list.length;i++)this.respond(list[i].rank,empty(),[id,i,list.length]);}return;
    }
    if([OP.INIT,OP.FINALIZE,OP.BARRIER,OP.FREE].includes(op)){for(const r of group)this.respond(r,empty(),op===OP.INIT?[group.indexOf(r),group.length]:[]);if(op===OP.FREE)this.comms.delete(a[0]);return;}
    if(!group.includes(group[root]))throw new Error('Invalid MPI collective root');
    if(items.some(p=>p.a.slice(1).some((v,i)=>v!==a[i+1])))throw new Error('MPI collective argument mismatch');
    let result=empty();
    if(op===OP.BCAST){result=items[root].data;if(result.length!==count*typeSizes[type])throw new Error('MPI broadcast size mismatch');}
    else if(op===OP.REDUCE||op===OP.ALLREDUCE)result=reduction(items.map(p=>p.data),type,reductionOp);
    else if(op===OP.GATHER||op===OP.ALLGATHER){if(items.some(p=>p.data.length!==receiveBytes))throw new Error('MPI gather size mismatch');result=join(items.map(p=>p.data));}
    else if(op===OP.SCATTER){result=items[root].data;if(result.length!==group.length*receiveBytes)throw new Error('MPI scatter size mismatch');}
    else throw new Error('Unimplemented MPI collective');
    for(let i=0;i<group.length;i++)this.respond(group[i],
      op===OP.SCATTER?result.slice(i*receiveBytes,(i+1)*receiveBytes):
      [OP.REDUCE,OP.GATHER].includes(op)&&i!==root?empty():result);
  }
}
