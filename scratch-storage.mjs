// Sparse, fixed-size blocks for large temporary integral files. Small scientific
// outputs stay in MEMFS. No reallocating/copying a whole scratch file on append.
export const SCRATCH_BLOCK_BYTES=1024*1024;
const threshold=4*SCRATCH_BLOCK_BYTES;
const scratchName=/^(?:AO(?:TWOINT|SUPINT|INTS\d*)|LUSUPM|LUDASP|LU[A-Z0-9_]*|SORT[A-Z0-9_]*|D[A-Z0-9_]*INT)$/;
export function installScratchStorage(FS) {
  const write=FS.write,read=FS.read,open=FS.open;
  function attach(stream,required=0) {
    const node=stream.node;
    if(!node||!FS.isFile(node.mode))return;
    if(node.daltonBlocks){stream.stream_ops=node.stream_ops;return;}
    if(Math.max(required,node.usedBytes??0)<threshold)return;
    if(!scratchName.test(stream.path.split('/').at(-1)))return;
    const blocks=new Map();
    if(node.usedBytes) {
      for(let p=0;p<node.usedBytes;p+=SCRATCH_BLOCK_BYTES){
        const block=new Uint8Array(SCRATCH_BLOCK_BYTES);
        block.set(node.contents.subarray(p,Math.min(node.usedBytes,p+SCRATCH_BLOCK_BYTES)));blocks.set(p/SCRATCH_BLOCK_BYTES,block);
      }
    }
    node.contents=new Uint8Array(0);node.daltonBlocks=blocks;
    const resize=size=>{
      if(!Number.isSafeInteger(size)||size<0)throw new FS.ErrnoError(28);
      if(size<node.usedBytes){
        const last=Math.floor(size/SCRATCH_BLOCK_BYTES);
        for(const key of blocks.keys())if(key>last||key===last&&size%SCRATCH_BLOCK_BYTES===0)blocks.delete(key);
        if(size%SCRATCH_BLOCK_BYTES)blocks.get(last)?.fill(0,size%SCRATCH_BLOCK_BYTES);
      }
      node.usedBytes=size;
    };
    const setattr=node.node_ops.setattr;
    node.node_ops={...node.node_ops,setattr(n,attr){
      if(attr.size!==undefined){resize(attr.size);const {size,...rest}=attr;setattr(n,rest);}
      else setattr(n,attr);
    }};
    node.stream_ops={...node.stream_ops,
      read(s,buffer,offset,length,position){
        const count=Math.max(0,Math.min(length,node.usedBytes-position));
        for(let done=0;done<count;){
          const p=position+done,index=Math.floor(p/SCRATCH_BLOCK_BYTES),within=p%SCRATCH_BLOCK_BYTES;
          const n=Math.min(count-done,SCRATCH_BLOCK_BYTES-within),block=blocks.get(index);
          if(block)buffer.set(block.subarray(within,within+n),offset+done);
          else buffer.fill(0,offset+done,offset+done+n);
          done+=n;
        }
        return count;
      },
      write(s,buffer,offset,length,position){
        if(length===0)return 0;
        if(!Number.isSafeInteger(position+length)||position<0)throw new FS.ErrnoError(28);
        for(let done=0;done<length;){
          const p=position+done,index=Math.floor(p/SCRATCH_BLOCK_BYTES),within=p%SCRATCH_BLOCK_BYTES;
          const n=Math.min(length-done,SCRATCH_BLOCK_BYTES-within);
          let block=blocks.get(index);if(!block){block=new Uint8Array(SCRATCH_BLOCK_BYTES);blocks.set(index,block);}
          block.set(buffer.subarray(offset+done,offset+done+n),within);done+=n;
        }
        node.usedBytes=Math.max(node.usedBytes,position+length);node.mtime=node.ctime=Date.now();return length;
      },
      allocate(s,offset,length){if(offset+length>node.usedBytes)resize(offset+length);},
      mmap(){throw new FS.ErrnoError(52);},
    };
    stream.stream_ops=node.stream_ops;
  }
  FS.open=function(...args){const stream=open.apply(this,args);attach(stream);return stream;};
  FS.read=function(stream,...args){
    if(stream.node?.daltonBlocks)stream.stream_ops=stream.node.stream_ops;
    return read.call(this,stream,...args);
  };
  FS.write=function(stream,buffer,offset,length,position,...args){
    attach(stream,(position??stream.position)+length);
    return write.call(this,stream,buffer,offset,length,position,...args);
  };
}
