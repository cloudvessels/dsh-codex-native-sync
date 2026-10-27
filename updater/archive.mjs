import fs from 'node:fs';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';

const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=bytes=>{let n=0xffffffff;for(const b of bytes)n=table[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;};
// Parse and validate the entire ZIP before writing. Never hand untrusted paths
// or symlinks to an external archive extractor.
export function unpackWindowsBundle(bytes,target){
  if(bytes.length>32*1024*1024)throw Error('UPDATE_ARCHIVE_TOO_LARGE');
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))throw Error('INVALID_UPDATE_ZIP');
  const count=bytes.readUInt16LE(end+10),start=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);
  if(count>1000||start+size!==end)throw Error('INVALID_UPDATE_DIRECTORY');
  const rows=[],names=new Set();let at=start,total=0;
  for(let i=0;i<count;i++){
    if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)throw Error('INVALID_UPDATE_ENTRY');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),checksum=bytes.readUInt32LE(at+16),packed=bytes.readUInt32LE(at+20),length=bytes.readUInt32LE(at+24);
    const nameLength=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),mode=bytes.readUInt32LE(at+38)>>>16,offset=bytes.readUInt32LE(at+42);
    if(at+46+nameLength+extra+comment>end||flags&1||![0,8].includes(method)||(mode&0xf000)===0xa000)throw Error('UNSUPPORTED_UPDATE_ENTRY');
    const raw=bytes.subarray(at+46,at+46+nameLength),name=raw.toString('utf8').replace(/^\.\//,'');at+=46+nameLength+extra+comment;
    if(name===''&&raw.toString()==='./')continue;
    if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.'||/^con$|^prn$|^aux$|^nul$|^(com|lpt)[0-9]$/i.test(p.split('.')[0])))throw Error('UNSAFE_UPDATE_PATH');
    const key=name.replace(/\/$/,'').toLowerCase();if(names.has(key))throw Error('DUPLICATE_UPDATE_PATH');names.add(key);
    if(offset+30>start||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+8)!==method||bytes.readUInt16LE(offset+6)&1)throw Error('INVALID_UPDATE_LOCAL_ENTRY');
    const localName=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),dataAt=offset+30+localName+localExtra;
    if(!raw.equals(bytes.subarray(offset+30,offset+30+localName))||dataAt+packed>start||length>16*1024*1024||(total+=length)>64*1024*1024)throw Error('INVALID_UPDATE_ENTRY_SIZE');
    const data=method===0?bytes.subarray(dataAt,dataAt+packed):inflateRawSync(bytes.subarray(dataAt,dataAt+packed),{maxOutputLength:Math.max(1,length)});
    if(data.length!==length||crc(data)!==checksum)throw Error('UPDATE_ENTRY_CHECKSUM_FAILED');
    if(!name.endsWith('/'))rows.push({name,data});
  }
  if(at!==end)throw Error('INVALID_UPDATE_DIRECTORY');
  // Exclusive creation prevents following a pre-existing directory or file link.
  if(fs.existsSync(target))throw Error('UPDATE_EXTRACTION_TARGET_EXISTS');
  fs.mkdirSync(target,{recursive:true});
  for(const row of rows){const file=path.join(target,row.name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,row.data,{flag:'wx'});}
  return rows.length;
}
