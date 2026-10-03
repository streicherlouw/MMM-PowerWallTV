const test = require('node:test');
const assert = require('node:assert/strict');
const { feedback } = require('../lib/export-feedback');
const at = Date.parse('2026-10-03T18:00:00+10:00');
const base = { updatedAt: at, enabled: true, confirmed: true, forecastKwh: 75, thresholdKwh: 35,
 forecastDate: '2026-10-04', timezone: 'Australia/Melbourne', startPercent: 90, stopPercent: 65,
 policy: 'battery_ok', soc: 85 };
test('forecast wording and confirmed active policy', () => {
 assert.deepEqual(feedback(base, at), { heading: 'Tomorrow: High solar forecast (75kWh)', detail: 'Battery export enabled until 65% charge or 9PM.' });
});
test('low forecast never claims battery export and equality is low', () => {
 assert.match(feedback({...base, forecastKwh:35, policy:'pv_only'},at).heading,/Low/);
 assert.match(feedback({...base, forecastKwh:24, policy:'pv_only'},at).detail,/Solar export only/);
 assert.match(feedback({...base, forecastKwh:24, policy:'never',soc:90},at).detail,/All export paused/);
});
test('unavailable forecast and charge boundaries', () => {
 assert.equal(feedback({...base,forecastKwh:null,policy:'never',soc:65},at).heading,'Tomorrow: Solar forecast unavailable');
 assert.match(feedback({...base,policy:'never',soc:65},at).detail,/paused at 65%/);
 assert.match(feedback({...base,policy:'never',soc:90},at).detail,/waiting/);
});
test('stale, failed and disabled controller cannot claim an active export plan', () => {
 assert.match(feedback(base,at+180001).heading,/unavailable/);
 assert.match(feedback({...base,confirmed:false},at).detail,/unconfirmed/);
 assert.match(feedback({...base,enabled:false},at).heading,/paused/);
});
test('before and after window messages and DST', () => {
 for (const [stamp,pattern] of [['2026-10-03T16:00:00+10:00',/starts above/],['2026-10-03T21:00:00+10:00',/ended/]]) {
 const now=Date.parse(stamp);assert.match(feedback({...base,updatedAt:now},now).detail,pattern);
 }
 const now=Date.parse('2026-10-04T18:00:00+11:00');
 assert.match(feedback({...base,updatedAt:now,forecastDate:'2026-10-05'},now).detail,/enabled until/);
});
