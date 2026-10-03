const test = require('node:test');
const assert = require('node:assert/strict');
const { feedback } = require('../lib/export-feedback');
const now = 1000000;
test('export caption describes the forecast plan even before export is enabled', () => {
 for (const [forecastKwh,heading] of [[75,'BATTERY EXPORT PLANNED'],[35,'BATTERY EXPORT BLOCKED'],[20,'BATTERY EXPORT BLOCKED'],[null,'CHARGE LIMITS APPLY']]) {
  assert.deepEqual(feedback({updatedAt:now,enabled:true,confirmed:true,policy:'pv_only',forecastKwh,thresholdKwh:35},now),{heading,detail:''});
 }
 assert.equal(feedback({updatedAt:now,enabled:false,confirmed:true},now).heading,'EXPORT CONTROL OFF');
});
test('missing, stale and unconfirmed settings remain unknown', () => {
 for (const status of [null,{}, {updatedAt:now,confirmed:false,policy:'battery_ok'},
  {updatedAt:now-180001,confirmed:true,policy:'pv_only'},
  {updatedAt:now+1,confirmed:true,policy:'battery_ok'}]) {
  assert.equal(feedback(status,now).heading,'EXPORT STATUS UNKNOWN');
 }
});
