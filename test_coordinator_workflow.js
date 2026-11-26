// The retired NTP Network must not accept, read, or publish directory records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { findReferenceSlot, REFERENCE_SLOTS } = require('./lib/provinceTemplate');
const { buildDashboardHtml } = require('./lib/buildDashboardHtml');
const assets = require('./lib/assets.generated');

(async () => {
  assert.equal(findReferenceSlot('NTP_NETWORK'), null);
  assert.deepEqual(REFERENCE_SLOTS.map(s => s.id), ['POPULATION', 'FACILITY_LIST']);
  for (const endpoint of ['coordinator-registration', 'coordinator-request']) {
    const handler = require('./api/' + endpoint);
    for (const method of ['GET', 'POST', 'DELETE']) {
      let status, body;
      await handler({ method, body: { action: 'approve', id: 'old-record' } }, {
        setHeader() {}, status(n) { status = n; return this; }, json(b) { body = b; return this; },
      });
      assert.equal(status, 410);
      assert.match(body.error, /removed/);
    }
  }
  const kpi = { meta: { ntp_network: { privateDirectory: 'RETIRED_DIRECTORY_SENTINEL' }, retained: 'KEEP_KPI_META' }, nodes: {} };
  const html = buildDashboardHtml(kpi);
  assert.ok(!html.includes('RETIRED_DIRECTORY_SENTINEL'));
  assert.ok(html.includes('KEEP_KPI_META'));
  assert.equal(kpi.meta.ntp_network.privateDirectory, 'RETIRED_DIRECTORY_SENTINEL', 'rendering does not mutate stored KPI');
  assert.ok(!assets.dashboardJsFull.includes('KPI.meta.ntp_network'));
  assert.ok(!assets.dashboardJsFull.includes('renderNtpNetwork'));
  assert.ok(!fs.readFileSync('api/index.js', 'utf8').includes('getAllReferenceEntries'));
  assert.ok(!fs.existsSync('lib/coordinatorRegistrationStore.js'));
  assert.ok(!fs.existsSync('lib/coordinatorRequestStore.js'));
  console.log('PASS: Network slot removed; retired endpoints return 410; legacy directory excluded; unrelated KPI metadata preserved.');
})().catch(err => { console.error(err); process.exitCode = 1; });
