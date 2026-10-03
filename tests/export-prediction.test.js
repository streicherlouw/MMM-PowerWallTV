const test = require("node:test");
const assert = require("node:assert/strict");
const { predictCharge } = require("../lib/export-prediction");
const now = Date.parse("2026-10-03T13:30:00+10:00");
const status = { timezone: "Australia/Melbourne", soc: 50 };
const snapshot = { batteryCount: 2, homePower: 1000 };
function cache(values = [4, 4, 4, 4], date = "2026-10-03", at = now) {
 return { instances: { solar: { forecast: { timezone: status.timezone, updatedAt: new Date(at).toISOString(),
  days: [{ date, hours: values.map((generationKwh,i) => ({ minuteOfDay: (13+i)*60,
   time: `${date}T${13+i}:00`, generationKwh })) }] } } } };
}
test("partial hours subtract current load and allow for charging losses", () => {
 const p = predictCharge(status,snapshot,cache(),{},now);
 assert.equal(p.available,true); assert.equal(p.solarKwh,14); assert.equal(p.loadKwh,3.5);
 assert.ok(Math.abs(p.projectedPercent - 85) < 1e-9);
});
test("battery projection includes discharge, saturation and a charging power cap", () => {
 const options = { capacityKwh:10, maxChargeKw:2, chargeEfficiency:1, dischargeEfficiency:1 };
 const p = predictCharge({ ...status,soc:90 },snapshot,cache([10,10,0,0]),options,now);
 assert.equal(p.projectedPercent,80); // Full by 3PM, then two hours of load.
 const q = predictCharge({ ...status,soc:50 },snapshot,cache([0,0,0,0]),
  { ...options,dischargeEfficiency:0.5 },now);
 assert.equal(q.projectedPercent,0);
});
test("missing load, capacity, forecast, gaps and stale cache never imply zero demand", () => {
 const missingHour=cache();missingHour.instances.solar.forecast.days[0].hours.splice(1,1);
 const duplicate=cache();duplicate.instances.solar.forecast.days[0].hours.push(duplicate.instances.solar.forecast.days[0].hours[0]);
 const ambiguous=cache();ambiguous.instances.other=ambiguous.instances.solar;
 const cases = [
  [snapshot,null,{}], [{...snapshot,homePower:null},cache(),{}], [{...snapshot,batteryCount:0},cache(),{}],
  [snapshot,cache([4,null,4,4]),{}], [snapshot,missingHour,{}], [snapshot,duplicate,{}],
  [snapshot,cache([4,4,4,4],"2026-10-03",now-7200001),{}], [snapshot,cache([4,4,4,4],"2026-10-03",now+1),{}],
  [snapshot,ambiguous,{}], [snapshot,cache(),{chargeEfficiency:0}],
  [{...snapshot,source:"v1r",predictionHomePowerWatts:null},cache(),{}]
 ];
 for(const [s,c,o] of cases) assert.equal(predictCharge(status,s,c,o,now).available,false);
 assert.equal(predictCharge(status,snapshot,ambiguous,{forecastInstanceId:"solar"},now).available,true);
});
test("uses local dates across DST and rejects prediction after 5PM", () => {
 const dst=Date.parse("2026-10-04T13:30:00+11:00");
 assert.equal(predictCharge(status,snapshot,cache([4,4,4,4],"2026-10-04",dst),{},dst).projectedPercent,85);
 assert.equal(predictCharge(status,snapshot,cache(),{},Date.parse("2026-10-03T17:00:00+10:00")).available,false);
});
