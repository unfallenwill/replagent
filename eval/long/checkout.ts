import type { EvalTask } from '../types.js';
import { functional, PACKAGE, preserved, publicTests, write } from './helpers.js';

const catalog = {
  book: { price: 1299, physical: true },
  pen: { price: 199, physical: true },
  course: { price: 4200, physical: false },
  sample: { price: 1, physical: true },
};
const fixtures = {
  'package.json': PACKAGE,
  'data/catalog.json': JSON.stringify(catalog),
  'README.md': `# Store checkout\nPublic entry: src/index.mjs. CLI: node bin/order.mjs input.json output.json.\nInput: {id,items:[{sku,quantity}],coupon?}. Prices are integer cents.\nExisting callers without a coupon must continue working. No external dependencies.\n`,
  'docs/coupons.md': `# Coupon contract\nAdd priceCart(items,catalog,{coupon}={}) and createOrder(id,items,catalog,{coupon}={}).\nNo coupon (undefined or null): discount=0. SAVE10: round(subtotal*0.10). TAKE500: min(500,subtotal).\nUnknown non-null coupon throws RangeError. Empty cart is allowed.\nItems have known sku and positive integer quantity; invalid items throw RangeError.\nsubtotal is before discounts. tax=round((subtotal-discount)*0.07).\nShipping is 500 cents when there is a physical item and subtotal-discount<3000; otherwise 0.\nThe result contains subtotal,discount,tax,shipping,total. total=subtotal-discount+tax+shipping.\nDo not mutate input items or catalog. CLI output has the order fields and an invoice string.\nInvoice must include lines Discount: <discount> and Total: <total> (integer cents).\nPreserve existing exports, the catalog, package.json and test/ files.\n`,
  'src/pricing.mjs': `export function priceCart(items,catalog){const subtotal=items.reduce((s,x)=>s+catalog[x.sku].price*x.quantity,0);const shipping=items.some(x=>catalog[x.sku].physical)&&subtotal<3000?500:0;const tax=Math.round(subtotal*.07);return {subtotal,tax,shipping,total:subtotal+tax+shipping};}\n`,
  'src/orders.mjs': `import {priceCart} from './pricing.mjs';\nexport function createOrder(id,items,catalog){return {id,items:items.map(x=>({...x})),...priceCart(items,catalog)};}\n`,
  'src/invoice.mjs': `export function renderInvoice(order){return ['Order: '+order.id,'Subtotal: '+order.subtotal,'Tax: '+order.tax,'Shipping: '+order.shipping,'Total: '+order.total].join('\\n')+'\\n';}\n`,
  'src/index.mjs': `export {priceCart} from './pricing.mjs';export {createOrder} from './orders.mjs';export {renderInvoice} from './invoice.mjs';\n`,
  'bin/order.mjs': `import fs from 'node:fs';import {createOrder,renderInvoice} from '../src/index.mjs';const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const catalog=JSON.parse(fs.readFileSync(new URL('../data/catalog.json',import.meta.url),'utf8'));const order=createOrder(input.id,input.items,catalog);fs.writeFileSync(process.argv[3],JSON.stringify({...order,invoice:renderInvoice(order)}));\n`,
  'test/legacy.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import {createOrder,renderInvoice} from '../src/index.mjs';test('legacy checkout',()=>{const order=createOrder('a',[{sku:'x',quantity:1}],{x:{price:1000,physical:true}});assert.equal(order.total,1570);assert.ok(renderInvoice(order).includes('Total: 1570'));});\n`,
};

const solution = {
  'src/pricing.mjs': `export function priceCart(items,catalog,{coupon}={}){
 if(coupon!=null&&!['SAVE10','TAKE500'].includes(coupon))throw new RangeError('Unknown coupon');
 let subtotal=0,physical=false;
 for(const item of items){if(!Object.hasOwn(catalog,item.sku)||!Number.isInteger(item.quantity)||item.quantity<=0)throw new RangeError('Invalid item');subtotal+=catalog[item.sku].price*item.quantity;physical ||= catalog[item.sku].physical;}
 const discount=coupon==='SAVE10'?Math.round(subtotal*.10):coupon==='TAKE500'?Math.min(500,subtotal):0;
 const taxable=subtotal-discount,tax=Math.round(taxable*.07),shipping=physical&&taxable<3000?500:0;
 return {subtotal,discount,tax,shipping,total:taxable+tax+shipping};
}\n`,
  'src/orders.mjs': `import {priceCart} from './pricing.mjs';export function createOrder(id,items,catalog,options={}){return {id,items:items.map(x=>({...x})),...priceCart(items,catalog,options)};}\n`,
  'src/invoice.mjs': `export function renderInvoice(order){return ['Order: '+order.id,'Subtotal: '+order.subtotal,'Discount: '+order.discount,'Tax: '+order.tax,'Shipping: '+order.shipping,'Total: '+order.total].join('\\n')+'\\n';}\n`,
  'bin/order.mjs': fixtures['bin/order.mjs'].replace(
    'input.items,catalog)',
    'input.items,catalog,{coupon:input.coupon})',
  ),
};

export const CHECKOUT: EvalTask = {
  id: 'long/development/checkout-feature',
  suite: 'capability',
  partition: 'development',
  description:
    'Carry a pricing feature through library, order service, invoice, and CLI without breaking legacy callers.',
  fixtures,
  turns: [
    'Implement the coupon feature specified in docs/coupons.md throughout this repository, including the CLI and invoice. Check the existing behavior and preserve the listed protected files.',
  ],
  checks: [
    functional(
      'pricing-contract',
      `
import {priceCart,createOrder,renderInvoice} from './src/index.mjs';
const catalog=${JSON.stringify(catalog)};
for(let n=0;n<36;n++)for(const coupon of [undefined,null,'SAVE10','TAKE500']){
 const items=n===0?[]:[{sku:n%2?'book':'course',quantity:n%5+1},{sku:'sample',quantity:n+1}];
 const original=JSON.stringify({items,catalog});const subtotal=items.reduce((s,x)=>s+catalog[x.sku].price*x.quantity,0);
 const discount=coupon==='SAVE10'?Math.round(subtotal*.1):coupon==='TAKE500'?Math.min(500,subtotal):0;
 const tax=Math.round((subtotal-discount)*.07),shipping=items.some(x=>catalog[x.sku].physical)&&subtotal-discount<3000?500:0;
 const expected={subtotal,discount,tax,shipping,total:subtotal-discount+tax+shipping};
 assert.deepEqual(priceCart(items,catalog,{coupon}),expected);
 const order=createOrder('id-'+n,items,catalog,{coupon});for(const [key,value] of Object.entries(expected))assert.equal(order[key],value);
 assert.equal(JSON.stringify({items,catalog}),original);assert.ok(renderInvoice(order).includes('Discount: '+discount));assert.ok(renderInvoice(order).includes('Total: '+expected.total));
}
for(const items of [[{sku:'missing',quantity:1}],[{sku:'book',quantity:0}],[{sku:'pen',quantity:1.5}]])assert.throws(()=>priceCart(items,catalog),RangeError);
assert.throws(()=>priceCart([],catalog,{coupon:'UNKNOWN'}),RangeError);
`,
    ),
    functional(
      'cli-integration',
      `
import fs from 'node:fs';import {execFileSync} from 'node:child_process';
fs.writeFileSync('request.json',JSON.stringify({id:'cli',items:[{sku:'book',quantity:3}],coupon:'SAVE10'}));
execFileSync(process.execPath,['bin/order.mjs','request.json','output.json']);const order=JSON.parse(fs.readFileSync('output.json','utf8'));
assert.equal(order.discount,390);assert.equal(order.total,3752);assert.ok(order.invoice.includes('Discount: 390'));assert.ok(order.invoice.includes('Total: 3752'));
`,
    ),
    publicTests(),
    ...preserved(fixtures, ['package.json', 'data/catalog.json', 'test/legacy.test.mjs']),
  ],
  reference: [write(solution)],
};
