import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function walk(dir) { return readdirSync(dir, { withFileTypes:true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(m?js)$/.test(e.name) ? [`${dir}/${e.name}`] : []); }
for (const f of ['src','public','scripts','test','examples'].flatMap(walk)) { const r = spawnSync(process.execPath,['--check',f],{stdio:'inherit'}); if (r.status) process.exit(r.status); }
console.log('All JavaScript files passed syntax checks.');
