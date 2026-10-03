const test = require('node:test');
const assert = require('node:assert/strict');
const { feedback } = require('../lib/export-feedback');
const now=Date.parse('2026-10-03T13:30:00+10:00');
const status={updatedAt:now,enabled:true,confirmed:true,timezone:'Australia/Melbourne',
 forecastDate:'2026-10-04',forecastKwh:75,thresholdKwh:35,startPercent:90,stopPercent:65,soc:50,policy:'pv_only'};
const projection={available:true,projectedPercent:95,solarKwh:15,loadKwh:3,homeLoadKw:1};
test('green requires both high tomorrow forecast and charge above the start threshold at 5PM',()=>{
 assert.equal(feedback(status,now,projection).heading,'BATTERY EXPORT PLANNED');
 for(const projectedPercent of [89,90]) assert.equal(feedback(status,now,{...projection,projectedPercent}).heading,'BATTERY EXPORT BLOCKED');
 assert.equal(feedback({...status,forecastKwh:35},now,projection).heading,'BATTERY EXPORT BLOCKED');
 assert.equal(feedback({...status,forecastKwh:20},now).heading,'BATTERY EXPORT BLOCKED');
 assert.match(feedback(status,now,projection).detail,/95.0% at 5PM/);
});
test('missing estimates, forecasts, stale status and disabled automation are grey',()=>{
 assert.equal(feedback(status,now).heading,'EXPORT STATUS UNKNOWN');
 assert.equal(feedback({...status,forecastKwh:null},now,projection).heading,'CHARGE LIMITS APPLY');
 assert.equal(feedback({...status,forecastDate:'2026-10-03'},now,projection).heading,'CHARGE LIMITS APPLY');
 assert.equal(feedback({...status,enabled:false,confirmed:false},now,projection).heading,'EXPORT CONTROL OFF');
 for(const s of [null,{}, {...status,confirmed:false},{...status,updatedAt:now-180001},{...status,updatedAt:now+1}])
  assert.equal(feedback(s,now,projection).heading,'EXPORT STATUS UNKNOWN');
});
test('during export window actual charge and latch replace the 5PM prediction',()=>{
 const at=Date.parse('2026-10-03T18:00:00+10:00');const s={...status,updatedAt:at};
 assert.equal(feedback({...s,soc:90},at,projection).heading,'BATTERY EXPORT BLOCKED');
 assert.equal(feedback({...s,soc:91},at).heading,'BATTERY EXPORT PLANNED');
 assert.equal(feedback({...s,soc:70,active:true,policy:'battery_ok'},at).heading,'BATTERY EXPORT PLANNED');
 assert.equal(feedback({...s,soc:65,active:true,policy:'battery_ok'},at).heading,'BATTERY EXPORT BLOCKED');
 const end=Date.parse('2026-10-03T21:00:00+10:00');
 assert.equal(feedback({...s,updatedAt:end,soc:100},end,projection).heading,'BATTERY EXPORT BLOCKED');
});
