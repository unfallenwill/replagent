import { hash } from '../files.js';
import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, unit, write } from './helpers.js';

function profiles(): Record<string, string> {
  const files: Record<string, string> = {};
  files['profiles/base.json'] = JSON.stringify({
    service: {
      host: `\${HOST:-localhost}`,
      port: 8080,
      tags: ['base'],
      retry: { attempts: 2, delay: 10 },
    },
    features: { audit: true, old: true },
    owners: ['platform'],
  });
  for (let i = 0; i < 40; i++) {
    files[`profiles/service-${i}.json`] = JSON.stringify({
      extends: i ? `service-${i - 1}` : 'base',
      service: {
        [`setting${i}`]: {
          enabled: i % 3 !== 0,
          weight: i * 17,
          labels: [`service-${i}`, 'shared'],
        },
      },
      [`module${i}`]: {
        endpoint: `/v${i % 4}/module${i}`,
        limits: { requests: 100 + i, burst: i + 1 },
      },
    });
  }
  files['profiles/region.json'] = JSON.stringify({
    service: { port: 9090, tags: ['region'] },
    region: { code: 'apac', replicas: 3 },
  });
  files['profiles/staging.json'] = JSON.stringify({
    extends: ['service-39', 'region'],
    service: { host: `\${HOST}`, retry: { delay: 0 } },
    features: { old: null },
    owners: ['staging'],
  });
  files['profiles/prod.json'] = JSON.stringify({
    extends: 'staging',
    service: { tags: ['production'], retry: { attempts: 5 } },
    region: { replicas: 8 },
    owners: [],
    unused: null,
  });
  return files;
}

const data = profiles();
const fixtures = {
  'package.json': PACKAGE,
  'README.md': `# Deployment config resolver\nThe authoritative format is docs/v2.md; docs/v1.md is retained only for migration history.\nPublic API: loadConfig(name,directory,{env={}}={}) from src/index.mjs.\nCLI: node bin/config.mjs name directory env.json output.json.\nDo not modify package.json, profiles/, docs/, or test/. No external packages.\n`,
  'docs/v1.md': `# Deprecated v1\nOld versions concatenate arrays and interpolate before merging. Do not use these rules for v2.\n`,
  'docs/v2.md': `# Config format v2\nA profile is <directory>/<name>.json, a JSON object. name must match /^[a-zA-Z0-9_-]+$/; invalid names throw RangeError.\nextends is an optional string or array of parent names. Recursively merge parents from left to right, then merge the child's own fields. Remove the root extends metadata from results.\nObjects merge recursively, arrays replace, scalars replace. null deletes a key, including absent keys. Do not mutate source objects or env.\nParent cycles throw TypeError; a missing file must throw. Shared parents are allowed and must not be confused with cycles.\nInterpolate strings only after all merging: \${VAR} takes env[VAR]; \${VAR:-fallback} uses fallback when VAR is absent; fallback may be empty. An explicitly present empty string is a value.\nMultiple placeholders and nested arrays/objects work. Preserve nonstring values. Missing variables without a fallback throw RangeError.\nOnly the supplied env is consulted. Never interpolate object keys. Earlier placeholders deleted or replaced during merging must not cause errors.\nThe CLI writes the exact resolved object as JSON.\n`,
  'src/index.mjs': `export {loadConfig} from './resolver.mjs';\n`,
  'src/resolver.mjs': `import fs from 'node:fs';import path from 'node:path';export function loadConfig(name,directory){return JSON.parse(fs.readFileSync(path.join(directory,name+'.json'),'utf8'));}\n`,
  'bin/config.mjs': `throw new Error('Not implemented');\n`,
  'test/legacy.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {loadConfig} from '../src/index.mjs';test('plain configuration',()=>{fs.mkdirSync('test-temp',{recursive:true});fs.writeFileSync('test-temp/simple.json','{"port":80}');assert.deepEqual(loadConfig('simple','test-temp'),{port:80});});\n`,
  ...data,
};

const resolver = `import fs from 'node:fs';import path from 'node:path';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function merge(base,patch){const out={...base};for(const [key,value] of Object.entries(patch)){if(value===null)delete out[key];else if(object(value))out[key]=merge(object(out[key])?out[key]:{},value);else out[key]=structuredClone(value);}return out;}
export function loadConfig(name,directory,{env={}}={}){const visiting=new Set();
function load(id){if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new RangeError('Invalid name');if(visiting.has(id))throw new TypeError('Cycle');visiting.add(id);const raw=JSON.parse(fs.readFileSync(path.join(directory,id+'.json'),'utf8'));const parents=raw.extends===undefined?[]:Array.isArray(raw.extends)?raw.extends:[raw.extends];let result={};for(const parent of parents)result=merge(result,load(parent));const {extends:ignored,...own}=raw;result=merge(result,own);visiting.delete(id);return result;}
function interpolate(value){if(typeof value==='string')return value.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\\}/g,(_,key,fallback)=>{if(Object.hasOwn(env,key))return String(env[key]);if(fallback!==undefined)return fallback;throw new RangeError('Missing '+key);});if(Array.isArray(value))return value.map(interpolate);if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,interpolate(v)]));return value;}
return interpolate(load(name));}\n`;
const cli = `import fs from 'node:fs';import {loadConfig} from '../src/index.mjs';const result=loadConfig(process.argv[2],process.argv[3],{env:JSON.parse(fs.readFileSync(process.argv[4],'utf8'))});fs.writeFileSync(process.argv[5],JSON.stringify(result));\n`;

export const CONFIG_RESOLVER: EvalTask = {
  id: 'long/holdout/config-context',
  suite: 'capability',
  partition: 'holdout',
  description:
    'Resolve a 40-level configuration inheritance chain while applying current contracts, merge semantics, and late interpolation.',
  fixtures,
  turns: [
    'Implement the v2 resolver and CLI using the authoritative contract in docs/v2.md. Resolve staging and prod from profiles/ with env={HOST:"api.example.test"}, saving snapshots/staging.json and snapshots/prod.json. Verify both generated outputs and general resolver behavior. Preserve protected files.',
  ],
  checks: [
    functional(
      'real-profile-chain',
      `
import fs from 'node:fs';import {loadConfig} from './src/index.mjs';
for(const name of ['staging','prod']){const r=loadConfig(name,'profiles',{env:{HOST:'api.example.test'}});assert.equal(r.service.host,'api.example.test');assert.equal(r.service.port,9090);assert.equal(r.service.retry.delay,0);assert.equal(r.features.audit,true);assert.ok(!Object.hasOwn(r.features,'old'));assert.ok(!Object.hasOwn(r,'extends'));assert.ok(!Object.hasOwn(r,'unused'));for(let i=0;i<40;i++){assert.equal(r.service['setting'+i].weight,i*17);assert.equal(r['module'+i].limits.burst,i+1);}assert.deepEqual(r.service.tags,[name==='prod'?'production':'region']);assert.deepEqual(r.owners,name==='prod'?[]:['staging']);assert.equal(r.region.replicas,name==='prod'?8:3);assert.deepEqual(JSON.parse(fs.readFileSync('snapshots/'+name+'.json','utf8')),r);}
`,
    ),
    functional(
      'unseen-merges-and-errors',
      `
import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {loadConfig} from './src/index.mjs';
fs.mkdirSync('cases',{recursive:true});const fixtures={root:{x:{a:1,b:2},arr:[1,2],gone:'\${MISSING}',fallback:'\${ABSENT:-}',message:'\${V}/\${V:-other}',literal:4},left:{extends:'root',x:{a:3},arr:[9]},right:{extends:'root',x:{c:7},arr:[]},child:{extends:['left','right'],x:{b:null},gone:null,values:['\${EMPTY:-fallback}',{z:'\${V}'}]},cycle1:{extends:'cycle2'},cycle2:{extends:'cycle1'},missing:{x:'\${NO_SUCH_VARIABLE}'}};for(const [name,data] of Object.entries(fixtures))fs.writeFileSync('cases/'+name+'.json',JSON.stringify(data));
const env={V:'resolved',EMPTY:''};const before=JSON.stringify(env);const r=loadConfig('child','cases',{env});assert.deepEqual(r,{x:{a:1,c:7},arr:[],fallback:'',message:'resolved/resolved',literal:4,values:['',{z:'resolved'}]});assert.equal(JSON.stringify(env),before);
assert.throws(()=>loadConfig('cycle1','cases'),TypeError);assert.throws(()=>loadConfig('missing','cases'),RangeError);assert.throws(()=>loadConfig('../root','cases'),RangeError);assert.throws(()=>loadConfig('absent','cases'));
fs.writeFileSync('env.json',JSON.stringify(env));execFileSync(process.execPath,['bin/config.mjs','child','cases','env.json','cli-config.json']);assert.deepEqual(JSON.parse(fs.readFileSync('cli-config.json','utf8')),r);
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'docs/v1.md', 'docs/v2.md', 'test/legacy.test.mjs']),
    functional(
      'profiles-preserved',
      `import fs from 'node:fs';import {createHash} from 'node:crypto';const hashes=${JSON.stringify(Object.fromEntries(Object.entries(data).map(([file, content]) => [file, hash(content)])))};for(const [file,h] of Object.entries(hashes))assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),h,file);`,
    ),
  ],
  reference: [
    write({ 'src/resolver.mjs': resolver, 'bin/config.mjs': cli }).replace(
      'say("Done");',
      'deposit("Resolver installed");',
    ),
    unit(
      `const fs=require('node:fs');const {loadConfig}=await import(require('node:url').pathToFileURL(require('node:path').resolve('src/index.mjs')).href);fs.mkdirSync('snapshots',{recursive:true});for(const name of ['staging','prod'])fs.writeFileSync('snapshots/'+name+'.json',JSON.stringify(loadConfig(name,'profiles',{env:{HOST:'api.example.test'}})));say('Done');`,
    ),
  ],
};
