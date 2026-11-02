import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('Deployment inspect uses only read-only diagnostics, never installer or service commands',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mb-inspect-'));
 try{
  for(const name of ['uname','cat','free','df','ss'])writeFileSync(path.join(dir,name),'#!/bin/sh\nprintf "diagnostic '+name+'\\n"\n',{mode:0o755});
  for(const name of ['useradd','systemctl','install','mkdir','rm','ln','mv','curl','tar','chown'])writeFileSync(path.join(dir,name),'#!/bin/sh\necho "UNEXPECTED_MUTATION"\nexit 99\n',{mode:0o755});
  const r=spawnSync('/bin/bash',['ops/github-deploy.sh','inspect'],{encoding:'utf8',env:{PATH:dir}});
  assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.includes('diagnostic ss'));assert.ok(!r.stdout.includes('UNEXPECTED_MUTATION'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Deployment rejects malformed archive/commit before reaching filesystem mutations',()=>{
 const r=spawnSync('/bin/bash',['ops/github-deploy.sh','deploy','not-a-sha','/etc/passwd','invalid','https://example.com:8443'],{encoding:'utf8'});assert.notEqual(r.status,0);
 const missing=spawnSync('/bin/bash',['ops/github-deploy.sh','deploy'],{encoding:'utf8'});assert.notEqual(missing.status,0);
});

test('Deployment workflow requires pinned host identity and never contains plaintext SSH password',()=>{
 const workflow=readFileSync('.github/workflows/mbusiness-deploy.yml','utf8');
 assert.match(workflow,/secrets\.MBUSINESS_SSH_PASSWORD/);assert.match(workflow,/StrictHostKeyChecking=yes/);assert.match(workflow,/SHA256:\+Tocz2KkwW2hYTRerF6SA4DwanAyaFcQa3nrl\+M2dcg/);
 assert.doesNotMatch(workflow,/StrictHostKeyChecking=no|sshpass -p|SSHPASS:\s*[^$\s]/);
 assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/default: inspect/);
});
