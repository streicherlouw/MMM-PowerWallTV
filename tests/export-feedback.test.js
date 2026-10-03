const test = require('node:test');
const assert = require('node:assert/strict');
const { feedback } = require('../lib/export-feedback');
const now = 1000000;
test('export caption describes the confirmed setting', () => {
 for (const [policy,heading] of [['battery_ok','BATTERY EXPORT ENABLED'],['pv_only','NO BATTERY EXPORT'],['never','NO BATTERY EXPORT']]) {
  assert.deepEqual(feedback({updatedAt:now,confirmed:true,policy},now),{heading,detail:''});
 }
});
test('missing, stale and unconfirmed settings remain unknown', () => {
 for (const status of [null,{}, {updatedAt:now,confirmed:false,policy:'battery_ok'},
  {updatedAt:now-180001,confirmed:true,policy:'pv_only'},
  {updatedAt:now+1,confirmed:true,policy:'battery_ok'},
  {updatedAt:now,confirmed:true,policy:'unexpected'}]) {
  assert.equal(feedback(status,now).heading,'EXPORT STATUS UNKNOWN');
 }
});
