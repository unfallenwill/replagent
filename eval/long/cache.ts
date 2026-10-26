import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, write } from './helpers.js';

const fixtures = {
  'package.json': PACKAGE,
  'README.md': `# Profile client\nPublic exports: src/index.mjs. Old imports from src/cache.mjs must remain supported.\nReplace the cache internals and update the profile service to use the new loading API. See docs/cache.md.\nNo external dependencies. Preserve package.json and existing tests.\n`,
  'docs/cache.md': `# Cache v2\ncreateCache({maxEntries=100,ttlMs=0,now=Date.now}={}) returns get,set,delete,clear,getOrLoad.\nmaxEntries must be a positive integer; ttlMs must be a finite nonnegative number. Invalid options throw RangeError.\nString keys, including __proto__, are supported. get missing returns undefined. set(key,value) returns value.\ndelete returns whether an unexpired stored entry existed. clear returns undefined.\nTTL starts at set or successful load completion. Entries expire at now()>=expiry. ttlMs=0 disables expiry.\nget and successful getOrLoad hits mark entries most recently used; set does too. Evict least recently used stored entry beyond capacity.\ngetOrLoad(key,loader) returns a Promise. Cache values including undefined and null.\nConcurrent misses for the same key invoke the loader once; different keys are independent. Failed loads must be retried next time.\nset/delete/clear invalidate older in-flight writes: their callers still receive their loaded value, but an older load must not overwrite explicit set, resurrect a deleted entry, or repopulate a cleared cache.\nA later load started after delete/clear may cache its result normally.\ncreateProfileService(fetcher,options={}) returns {read(id),invalidate(id)}. read uses getOrLoad to deduplicate concurrent fetcher(id) calls; invalidate uses delete.\nKeep legacy get/set/delete/clear and imports working. Do not mutate caller options.\n`,
  'src/cache.mjs': `export function createCache(){const values={};return {get:key=>values[key],set(key,value){values[key]=value;return value},delete(key){const existed=key in values;delete values[key];return existed},clear(){for(const key of Object.keys(values))delete values[key]}};}\n`,
  'src/service.mjs': `import {createCache} from './cache.mjs';export function createProfileService(fetcher,options={}){const cache=createCache(options);return {async read(id){const hit=cache.get(id);if(hit!==undefined)return hit;const value=await fetcher(id);cache.set(id,value);return value},invalidate:id=>cache.delete(id)};}\n`,
  'src/index.mjs': `export {createCache} from './cache.mjs';export {createProfileService} from './service.mjs';\n`,
  'test/legacy.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import {createCache} from '../src/cache.mjs';test('old API',()=>{const cache=createCache();assert.equal(cache.get('missing'),undefined);assert.equal(cache.set('a',1),1);assert.equal(cache.get('a'),1);assert.equal(cache.delete('a'),true);assert.equal(cache.delete('a'),false);cache.set('b',2);assert.equal(cache.clear(),undefined);assert.equal(cache.get('b'),undefined);});\n`,
};

const solution = {
  'src/cache.mjs': `export function createCache({maxEntries=100,ttlMs=0,now=Date.now}={}){
 if(!Number.isInteger(maxEntries)||maxEntries<=0||!Number.isFinite(ttlMs)||ttlMs<0)throw new RangeError('Invalid cache options');
 const values=new Map(),pending=new Map();
 const entry=key=>{const value=values.get(key);if(value&&ttlMs&&now()>=value.expiry){values.delete(key);return undefined;}return value;};
 const touch=(key,value)=>{values.delete(key);values.set(key,value);};
 const store=(key,value)=>{touch(key,{value,expiry:ttlMs?now()+ttlMs:Infinity});while(values.size>maxEntries)values.delete(values.keys().next().value);return value;};
 return {get(key){const found=entry(key);if(found)touch(key,found);return found?.value;},
 set(key,value){pending.delete(key);return store(key,value);},delete(key){const exists=!!entry(key);values.delete(key);pending.delete(key);return exists;},clear(){values.clear();pending.clear();},
 getOrLoad(key,loader){const found=entry(key);if(found){touch(key,found);return Promise.resolve(found.value);}if(pending.has(key))return pending.get(key).promise;
 const token={};const promise=Promise.resolve().then(()=>loader()).then(value=>{if(pending.get(key)===token){pending.delete(key);store(key,value);}return value;},error=>{if(pending.get(key)===token)pending.delete(key);throw error;});token.promise=promise;pending.set(key,token);return promise;}};
}\n`,
  'src/service.mjs': `import {createCache} from './cache.mjs';export function createProfileService(fetcher,options={}){const cache=createCache(options);return {read:id=>cache.getOrLoad(id,()=>fetcher(id)),invalidate:id=>cache.delete(id)};}\n`,
};

export const CACHE_MIGRATION: EvalTask = {
  id: 'long/development/cache-migration',
  suite: 'capability',
  partition: 'development',
  description:
    'Migrate a legacy cache while preserving API compatibility, TTL/LRU behavior, and concurrent-load correctness.',
  fixtures,
  turns: [
    'Implement docs/cache.md and migrate the profile service. Verify async races as well as the synchronous legacy API; keep all existing entry points and protected files.',
  ],
  checks: [
    functional(
      'ttl-lru-and-compatibility',
      `
import {createCache} from './src/index.mjs';import {createCache as old} from './src/cache.mjs';assert.equal(old,createCache);
let time=100;const c=createCache({maxEntries:2,ttlMs:10,now:()=>time});c.set('a',1);c.set('b',2);assert.equal(c.get('a'),1);c.set('c',3);assert.equal(c.get('b'),undefined);time=109;assert.equal(c.get('a'),1);time=110;assert.equal(c.get('a'),undefined);assert.equal(c.delete('c'),false);
const unboundedTime=createCache({ttlMs:0,now:()=>time});unboundedTime.set('__proto__',null);time=1e8;assert.equal(unboundedTime.get('__proto__'),null);
for(const options of [{maxEntries:0},{maxEntries:1.2},{ttlMs:-1},{ttlMs:Infinity}])assert.throws(()=>createCache(options),RangeError);
let loads=0;const absent=createCache();assert.equal(await absent.getOrLoad('u',()=>{loads++;return undefined}),undefined);await absent.getOrLoad('u',()=>{loads++;return 9});assert.equal(loads,1);
`,
    ),
    functional(
      'async-races',
      `
import {createCache,createProfileService} from './src/index.mjs';
let release;let loads=0;const c=createCache();const loader=()=>{loads++;return new Promise(r=>{release=r})};const a=c.getOrLoad('x',loader),b=c.getOrLoad('x',loader);await Promise.resolve();assert.equal(loads,1);release(7);assert.deepEqual(await Promise.all([a,b]),[7,7]);assert.equal(c.get('x'),7);
let failures=0;await assert.rejects(c.getOrLoad('bad',()=>{failures++;throw Error('temporary')}));assert.equal(await c.getOrLoad('bad',()=>{failures++;return 8}),8);assert.equal(failures,2);
for(const action of ['set','delete','clear']){const cache=createCache();let done;const p=cache.getOrLoad('k',()=>new Promise(r=>{done=r}));await Promise.resolve();if(action==='set')cache.set('k','new');else if(action==='delete')cache.delete('k');else cache.clear();done('old');assert.equal(await p,'old');assert.equal(cache.get('k'),action==='set'?'new':undefined);assert.equal(await cache.getOrLoad('k',()=> 'later'),action==='set'?'new':'later');}
let clock=0,finish;const timed=createCache({ttlMs:10,now:()=>clock});const p=timed.getOrLoad('a',()=>new Promise(r=>{finish=r}));await Promise.resolve();clock=50;finish(42);await p;clock=59;assert.equal(timed.get('a'),42);clock=60;assert.equal(timed.get('a'),undefined);
let fetched=0;const service=createProfileService(async id=>{fetched++;await new Promise(r=>setTimeout(r,5));return {id}});const profiles=await Promise.all(Array.from({length:12},()=>service.read('u')));assert.equal(fetched,1);assert.ok(profiles.every(x=>x.id==='u'));service.invalidate('u');await service.read('u');assert.equal(fetched,2);
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'test/legacy.test.mjs']),
  ],
  reference: [write(solution)],
};
