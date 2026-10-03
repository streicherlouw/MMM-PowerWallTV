const test = require('node:test');
const assert = require('node:assert/strict');
const { feedback } = require('../lib/export-feedback');
const at = Date.parse('2026-10-03T18:00:00+10:00');
const base = { updatedAt: at, enabled: true, confirmed: true, forecastKwh: 75, thresholdKwh: 35,
 forecastDate: '2026-10-04', timezone: 'Australia/Melbourne', startPercent: 90, stopPercent: 65,
 policy: 'battery_ok', soc: 85 };
test('concise messages follow confirmed controller states', () => {
 const cases = [
  [{}, 'High solar forecast · Battery export enabled'],
  [{forecastKwh:35,policy:'pv_only'}, 'Low solar forecast · Battery export disabled'],
  [{forecastKwh:24,policy:'never',soc:90}, 'Low solar forecast · Battery export disabled'],
  [{forecastKwh:null,policy:'never',soc:65}, 'Solar forecast unavailable · Using charge limits'],
  [{policy:'never',soc:65}, 'Battery export paused · Waiting for charge above 90%'],
  [{policy:'never',soc:90}, 'High solar forecast · Waiting for charge above 90%'],
  [{policy:'never',soc:60,startPercent:95}, 'Battery export paused · Waiting for charge above 95%'],
  [{enabled:false}, 'Automatic export control off']
 ];
 for (const [overrides,heading] of cases) assert.deepEqual(feedback({...base,...overrides},at),{heading,detail:''});
});
test('stale, failed, contradictory and missing controller status cannot claim export', () => {
 for (const status of [null,{...base,updatedAt:at-180001},{...base,confirmed:false},
  {...base,forecastDate:'2026-10-03'},{...base,forecastKwh:24}]) {
  assert.equal(feedback(status,at).heading,'Powerwall unavailable · Export status unconfirmed');
 }
});
test('before and after window messages and DST', () => {
 for (const [stamp,expected] of [
  ['2026-10-03T16:00:00+10:00','High solar forecast · Battery export planned'],
  ['2026-10-03T21:00:00+10:00','Export window ended · Battery export disabled']]) {
  const now=Date.parse(stamp);
  assert.equal(feedback({...base,policy:'pv_only',updatedAt:now},now).heading,expected);
  assert.match(feedback({...base,updatedAt:now},now).heading,/unconfirmed/);
 }
 const now=Date.parse('2026-10-04T18:00:00+11:00');
 assert.equal(feedback({...base,updatedAt:now,forecastDate:'2026-10-05'},now).heading,
  'High solar forecast · Battery export enabled');
});
