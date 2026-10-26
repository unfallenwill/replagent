import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, write } from './helpers.js';

const fixtures = {
  'package.json': PACKAGE,
  'README.md': `# Local build runner\nImplement the dependency scheduler specified in docs/runner.md and wire it into src/build.mjs.\nRun without external services or packages. Preserve package.json and test/.\n`,
  'docs/runner.md': `# runGraph(jobs,worker,{concurrency=2}={})\nExport runGraph from src/index.mjs. Return a Promise of results in the original jobs order.\nJobs are {id,deps,payload?}; id is a nonempty string, deps is an array of job ids.\nBefore any worker runs, reject invalid concurrency (nonpositive/noninteger) with RangeError; reject duplicate/unknown ids and cycles with TypeError.\nRespect deps, execute each job at most once and never exceed concurrency. Start ready jobs whenever a slot is free.\nworker(job,dependencyValues) receives the original job and an object containing only its direct dependencies' successful values, keyed by id.\nSuccess result: {id,status:'success',value}. Error result: {id,status:'failed',error: error.message or String(error)}.\nA job whose dependency failed or was skipped must never invoke worker; result {id,status:'skipped',error:'dependency failed'}.\nIndependent branches continue after errors. Handle synchronous throws and rejected promises. Empty graph returns [].\nDo not mutate jobs, deps or payloads. Support arbitrary ids including __proto__.\nrunBuild(jobs,worker,options) is a public wrapper and must delegate to the scheduler and return {results,ok}, where ok is true exactly when all jobs succeeded.\n`,
  'src/index.mjs': `export {runGraph} from './scheduler.mjs';export {runBuild} from './build.mjs';\n`,
  'src/scheduler.mjs': `export async function runGraph(jobs,worker){const results=[];for(const job of jobs){results.push({id:job.id,status:'success',value:await worker(job,{})});}return results;}\n`,
  'src/build.mjs': `import {runGraph} from './scheduler.mjs';export async function runBuild(jobs,worker,options){const results=await runGraph(jobs,worker,options);return {results,ok:true};}\n`,
  'test/legacy.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import {runBuild} from '../src/index.mjs';test('single job',async()=>{assert.deepEqual(await runBuild([{id:'a',deps:[]}],async()=>1),{results:[{id:'a',status:'success',value:1}],ok:true});});\n`,
};

const solution = {
  'src/scheduler.mjs': `export async function runGraph(jobs,worker,{concurrency=2}={}){
if(!Number.isInteger(concurrency)||concurrency<=0)throw new RangeError('Invalid concurrency');
const byId=new Map();for(const job of jobs){if(typeof job.id!=='string'||!job.id||!Array.isArray(job.deps)||byId.has(job.id))throw new TypeError('Invalid job');byId.set(job.id,job);}
const visiting=new Set(),visited=new Set();function visit(id){if(!byId.has(id)||visiting.has(id))throw new TypeError('Invalid dependency graph');if(visited.has(id))return;visiting.add(id);for(const dep of byId.get(id).deps)visit(dep);visiting.delete(id);visited.add(id);}for(const job of jobs)visit(job.id);
const results=new Map(),started=new Set();let active=0;
return new Promise(resolve=>{function pump(){let changed=true;while(changed){changed=false;for(const job of jobs){if(started.has(job.id))continue;if(job.deps.some(id=>results.has(id)&&results.get(id).status!=='success')){started.add(job.id);results.set(job.id,{id:job.id,status:'skipped',error:'dependency failed'});changed=true;}}}
for(const job of jobs){if(active>=concurrency)break;if(started.has(job.id)||!job.deps.every(id=>results.has(id)))continue;started.add(job.id);active++;const values=Object.fromEntries(job.deps.map(id=>[id,results.get(id).value]));Promise.resolve().then(()=>worker(job,values)).then(value=>results.set(job.id,{id:job.id,status:'success',value}),error=>results.set(job.id,{id:job.id,status:'failed',error:error instanceof Error?error.message:String(error)})).finally(()=>{active--;pump();});}
if(results.size===jobs.length)resolve(jobs.map(job=>results.get(job.id)));}pump();});}\n`,
  'src/build.mjs': `import {runGraph} from './scheduler.mjs';export async function runBuild(jobs,worker,options){const results=await runGraph(jobs,worker,options);return {results,ok:results.every(x=>x.status==='success')};}\n`,
};

export const GRAPH_SCHEDULER: EvalTask = {
  id: 'long/holdout/dependency-scheduler',
  suite: 'capability',
  partition: 'holdout',
  description:
    'Implement bounded dependency scheduling, branch failure isolation, validation, and public build integration.',
  fixtures,
  turns: [
    'Implement docs/runner.md throughout the build runner. Validate the graph before side effects, keep independent work moving after failures, and retain the existing API and tests.',
  ],
  checks: [
    functional(
      'dependency-and-concurrency',
      `
import {runGraph} from './src/index.mjs';
for(const concurrency of [1,2,4]){const jobs=Array.from({length:18},(_,i)=>({id:'j'+i,deps:i>2?['j'+Math.floor((i-1)/2)]:[],payload:{n:i}}));const before=JSON.stringify(jobs),done=new Map();let active=0,peak=0;const results=await runGraph(jobs,async(job,values)=>{active++;peak=Math.max(peak,active);assert.ok(active<=concurrency);for(const dep of job.deps){assert.ok(done.has(dep));assert.equal(values[dep],done.get(dep));}await new Promise(r=>setTimeout(r,(17-job.payload.n)%4));active--;const value=job.payload.n+Object.values(values).reduce((a,b)=>a+b,0);done.set(job.id,value);return value;},{concurrency});assert.ok(peak<=concurrency);if(concurrency>1)assert.ok(peak>1);assert.equal(JSON.stringify(jobs),before);assert.deepEqual(results,jobs.map(j=>({id:j.id,status:'success',value:done.get(j.id)})));}
assert.deepEqual(await runGraph([],()=>0),[]);
const special=await runGraph([{id:'__proto__',deps:[]},{id:'child',deps:['__proto__']}],(job,values)=>job.id==='child'?values.__proto__+1:4);assert.equal(special[1].value,5);
`,
    ),
    functional(
      'failure-isolation-and-validation',
      `
import {runGraph,runBuild} from './src/index.mjs';
const jobs=[{id:'bad',deps:[]},{id:'blocked',deps:['bad']},{id:'blocked2',deps:['blocked']},{id:'good',deps:[]},{id:'child',deps:['good']}];const seen=[];const results=await runGraph(jobs,(job,values)=>{seen.push(job.id);if(job.id==='bad')throw Error('boom');return job.id==='good'?8:values.good+1;},{concurrency:2});assert.deepEqual(results,[{id:'bad',status:'failed',error:'boom'},{id:'blocked',status:'skipped',error:'dependency failed'},{id:'blocked2',status:'skipped',error:'dependency failed'},{id:'good',status:'success',value:8},{id:'child',status:'success',value:9}]);assert.ok(!seen.includes('blocked'));assert.ok(!seen.includes('blocked2'));assert.equal((await runBuild(jobs,async j=>{if(j.id==='bad')throw Error('boom');return 1})).ok,false);
let calls=0;for(const invalid of [[{id:'a',deps:['missing']}],[{id:'a',deps:['b']},{id:'b',deps:['a']}],[{id:'a',deps:[]},{id:'a',deps:[]}]])await assert.rejects(runGraph(invalid,()=>{calls++;return 0}),TypeError);for(const concurrency of [0,-1,1.5])await assert.rejects(runGraph([],()=>{calls++},{concurrency}),RangeError);assert.equal(calls,0);
`,
    ),
    functional(
      'free-slots-progress',
      `
import {runGraph} from './src/index.mjs';
let releaseSlow;const started=[];const slow=new Promise(r=>{releaseSlow=r});
const pending=runGraph([{id:'slow',deps:[]},{id:'quick',deps:[]},{id:'next',deps:['quick']}],async job=>{started.push(job.id);if(job.id==='slow')await slow;if(job.id==='next')releaseSlow();return job.id;},{concurrency:2});
const timeout=new Promise((_,reject)=>setTimeout(()=>{releaseSlow();reject(Error('An idle slot waited for an unrelated slow branch'))},1500));await Promise.race([pending,timeout]);assert.ok(started.includes('next'));
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'test/legacy.test.mjs']),
  ],
  reference: [write(solution)],
};
