import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow=readFileSync('.github/workflows/kaspi-upstream.yml','utf8');
const script=workflow.split('          script: |\n')[1].split('\n').filter(line=>line.startsWith('            ')).map(line=>line.slice(12)).join('\n');
const run=new (Object.getPrototypeOf(async function(){}).constructor)('require','github','context','core','process',script);
const reviewed='1'.repeat(40),latest='2'.repeat(40),marker='<!-- mbusiness-kaspi-upstream -->';
function fixture({head=latest,issues=[]}={}){
 const calls=[];const github={rest:{repos:{getBranch:async()=>({data:{commit:{sha:head}}}),compareCommitsWithBasehead:async()=>({data:{status:'ahead',ahead_by:3}})},issues:{listForRepo:()=>{},update:async v=>calls.push(v),create:async v=>{calls.push(v);return {data:{number:10}};}}},paginate:async()=>issues};
 return {calls,execute:()=>run(()=>({readFileSync:()=>JSON.stringify({repository:'tapter-dev/kaspi-pos-automation',branch:'main',reviewed_commit:reviewed})}),github,{repo:{owner:'test',repo:'service'}},{info:()=>{}},{env:{}})};
}
test('Upstream monitor creates a review issue for new source revisions without merging code',async()=>{const f=fixture();await f.execute();assert.equal(f.calls.length,1);assert.match(f.calls[0].body,new RegExp(latest));assert.match(f.calls[0].body,/не применяются/);assert.equal(f.calls[0].title,'[Kaspi upstream] Обновления для проверки');});
test('Upstream monitor does not repeatedly notify the same revision, even after manual issue closure',async()=>{const f=fixture({issues:[{number:10,state:'closed',title:'[Kaspi upstream] Обновления для проверки',body:marker+'<!-- kaspi-head:'+latest+' -->'}]});await f.execute();assert.equal(f.calls.length,0);});
test('Upstream monitor updates one existing issue when upstream advances again',async()=>{const f=fixture({issues:[{number:10,state:'closed',title:'[Kaspi upstream] Обновления для проверки',body:marker+'<!-- kaspi-head:'+reviewed+' -->'}]});await f.execute();assert.equal(f.calls.length,1);assert.equal(f.calls[0].issue_number,10);assert.equal(f.calls[0].state,'open');});
test('Upstream monitor closes an outstanding issue once the reviewed revision matches upstream',async()=>{const f=fixture({head:reviewed,issues:[{number:10,state:'open',title:'[Kaspi upstream] Обновления для проверки',body:marker}]});await f.execute();assert.equal(f.calls[0].state,'closed');assert.equal(f.calls[0].state_reason,'completed');});
