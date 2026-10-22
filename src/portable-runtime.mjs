import fs from 'node:fs';import path from 'node:path';
export function portableRuntime(root){
 const marker=path.join(root,'.runtime','windows','current.json');
 if(!fs.existsSync(marker))return null;
 const m=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(!/^[a-f0-9]{16}$/.test(m.runtime_id))throw new Error('Invalid portable runtime marker; run setup.cmd');
 const base=path.join(root,'.runtime','windows','runtimes',m.runtime_id);
 return {python:path.join(base,'python','python.exe'),node:path.join(base,'node','node.exe')};
}
