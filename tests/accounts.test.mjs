import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
const directory = await mkdtemp(join(tmpdir(), '4running-accounts-'));
const port = 4180, base = `http://localhost:${port}`;
const app = await startServer({ port, directory, testMail: true, migrate: true });
function client() {
  let cookies = new Map();
  return async (path, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json', Cookie: [...cookies].map(([k,v])=>`${k}=${v}`).join('; ') }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const line of res.headers.getSetCookie()) { const [pair] = line.split(';'); const at = pair.indexOf('='); cookies.set(pair.slice(0,at), pair.slice(at+1)); }
    return { status: res.status, data: await res.json() };
  };
}
const password = 'Running-test-12345';
const a=client(), b=client(), fresh=client();
try {
  assert.equal((await fresh('/api/state')).status,401);
  for (const [call,email] of [[a,'beginner@example.com'],[b,'runner@example.com']]) {
    const result=await call('/api/auth/sign-up/email',{email,password,name:email}); assert.equal(result.status,200,JSON.stringify(result));
    assert.equal((await call('/api/auth/get-session')).data.user.email,email);
  }
  const data={account:{displayName:'Beginner'},settings:{runSpeed:7},plan:{onboardingCompleted:true,sessions:[]},logs:[{id:'session-1',rpe:4},{id:'session-1',rpe:4}]};
  assert.equal((await a('/api/state',{revision:0,mutationId:'first-session-save',data},'PUT')).status,200);
  const retry = await a('/api/state',{revision:0,mutationId:'first-session-save',data},'PUT');
  assert.equal(retry.status,200);assert.equal(retry.data.replayed,true,'lost acknowledgement retry returns original success');
  const saved=await a('/api/state'); assert.equal(saved.data.data.logs.length,1);
  assert.equal((await b('/api/state')).data.data,null);
  // Same import repeated under a new revision still has one session.
  assert.equal((await a('/api/state',{revision:1,data},'PUT')).status,200);
  assert.equal((await a('/api/state')).data.data.logs.length,1);
  assert.equal((await a('/api/state',{revision:1,data},'PUT')).status,409,'stale retry may not overwrite another device');
  assert.equal((await b('/api/state',{revision:0,data:{...data,logs:[{id:'other',rpe:8}],userId:saved.data.userId}},'PUT')).status,200);
  assert.equal((await a('/api/state')).data.data.logs[0].id,'session-1');
  assert.equal((await a('/api/auth/sign-out',{})).status,200);
  assert.equal((await a('/api/state')).status,401);
  assert.equal((await fresh('/api/auth/sign-in/email',{email:'beginner@example.com',password:'wrong-password'})).status,401);
  assert.equal((await fresh('/api/auth/sign-in/email',{email:'beginner@example.com',password})).status,200);
  assert.equal((await fresh('/api/state')).data.data.account.displayName,'Beginner','new client restores profile');
  const reset=await fresh('/api/auth/request-password-reset',{email:'beginner@example.com',redirectTo:base+'/'});
  assert.equal(reset.status,200,JSON.stringify(reset));
  const mail=JSON.parse((await readFile(join(directory,'mail-outbox.jsonl'),'utf8')).trim().split('\n').at(-1));
  const url=new URL(mail.url); const token=url.pathname.split('/').at(-1);
  const recovery=client();
  assert.equal((await recovery('/api/auth/reset-password',{token,newPassword:'New-runner-pass-12345'})).status,200);
  assert.equal((await recovery('/api/auth/reset-password',{token,newPassword:password})).status,400,'one-use reset token');
  assert.equal((await fresh('/api/state')).status,401,'reset revokes prior sessions');
  assert.equal((await recovery('/api/auth/sign-in/email',{email:'beginner@example.com',password:'New-runner-pass-12345'})).status,200);
  assert.equal((await recovery('/api/state')).data.data.logs.length,1);
  const current = (await recovery('/api/state')).data;
  const changedPlan = { onboardingCompleted: true, sessions: [{id:'future',attempts:[]}] };
  const operation = {mutationId:'operation-first',basePlan:current.data.plan,changes:{plan:changedPlan,logs:[{id:'new-a',updatedAt:'2026-11-12T10:00:00Z',rpe:4}]}};
  assert.equal((await recovery('/api/sync',operation)).data.planConflict,false);
  assert.equal((await recovery('/api/sync',operation)).data.replayed,true);
  const divergent = await recovery('/api/sync',{mutationId:'operation-divergent',basePlan:current.data.plan,changes:{plan:{...changedPlan,sessions:[]},logs:[{id:'new-b',rpe:8}]}});
  assert.equal(divergent.status,200);assert.equal(divergent.data.planConflict,true);
  const retained = (await recovery('/api/state')).data.data;
  assert.equal(retained.plan.sessions[0].id,'future','divergent plan must not overwrite accepted plan');
  assert.ok(retained.logs.some(log=>log.id==='new-a') && retained.logs.some(log=>log.id==='new-b'),'divergent plans preserve every session');
  await recovery('/api/sync',{mutationId:'stale-copy',changes:{logs:[{id:'new-a',rpe:1}]}});
  assert.equal((await recovery('/api/state')).data.data.logs.find(log=>log.id==='new-a').rpe,4,'stale history snapshot cannot undo a timestamped correction');
  assert.equal((await fetch(base+'/api/sync',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(operation)})).status,401);
  const hostile=await fetch(base+'/api/state',{method:'PUT',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({revision:0,data})});
  assert.ok([401,403].includes(hostile.status));
  assert.equal((await fetch(base+'/work/data/4running.sqlite')).status,404);
  assert.equal((await fetch(base+'/.git/config')).status,404);
  console.log('PASS: two accounts, isolated server data, new device, idempotent import/retry, conflict, logout, password reset and private files.');
} finally { await app.close(); await rm(directory,{recursive:true,force:true}); }
