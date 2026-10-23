import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices, focusedApp, sanitizedNodes, preferredAbi } from '../scripts/mac-support.mjs';

test('Mac capture selects only listed devices; unauthorized and offline stay distinct', () => {
  assert.deepEqual(parseDevices('List of devices attached\n\nemulator-5554 device product:sdk model:Pixel\nABC123 unauthorized\nother offline\n* daemon started successfully *\n'),[
    {id:'emulator-5554',state:'device'},{id:'ABC123',state:'unauthorized'},{id:'other',state:'offline'},
  ]);
});
test('Observed foreground component supports both Android dumpsys formats', () => {
  assert.deepEqual(focusedApp('mCurrentFocus=Window{abcd u0 example.cashier/.MainActivity}'),{app_package:'example.cashier',app_activity:'.MainActivity'});
  assert.deepEqual(focusedApp('topResumedActivity=ActivityRecord{abc u0 example.cashier/example.cashier.Main t2}'),{app_package:'example.cashier',app_activity:'example.cashier.Main'});
  assert.throws(()=>focusedApp('mCurrentFocus=null'));
});
test('Capture removes customer data, passwords, unknown attributes, overlays and encoded texts', () => {
  const xml = `<?xml version="1.0"?><hierarchy rotation="0">
    <node package="example.cashier" resource-id="example.cashier:id/phone" class="android.widget.EditText" text="+77001234567" content-desc="Dmitriy 123456" bounds="[1,2][30,40]" password="false" secret="rawtoken" />
    <node package="example.cashier" text="Сумма" content-desc="&#43;77001234567" />
    <node package="example.cashier" text="Сумма" password="true" />
    <node package="example.cashier" text="15000 ₸" resource-id="example.cashier:id/account/123456789012" />
    <node package="com.android.systemui" text="SMS 654321" />
  </hierarchy>`;
  const nodes=sanitizedNodes(xml,'example.cashier'),text=JSON.stringify(nodes);
  assert.equal(nodes.length,4);
  assert.equal(nodes[0].resource_id,'example.cashier:id/phone');
  assert.equal(nodes[0].class,'android.widget.EditText');
  assert.equal(nodes[1].text,'Сумма');
  assert.equal(nodes[2].text,'[скрыто]');
  assert.equal(nodes[3].resource_id,undefined);
  for (const s of ['77001234567','Dmitriy','123456','654321','rawtoken','15000']) assert.ok(!text.includes(s),s);
});
test('Empty, truncated or inaccessible Android trees fail without pretending capture worked', () => {
  assert.throws(()=>sanitizedNodes('ERROR: null root node','example.cashier'));
  assert.throws(()=>sanitizedNodes('<hierarchy><node package="example.cashier" />','example.cashier'));
  assert.throws(()=>sanitizedNodes('<hierarchy><node package="keyboard.app" /></hierarchy>','example.cashier'));
});
test('Mac ABI detects Apple Silicon even when Node runs under Rosetta', () => {
  assert.equal(preferredAbi('arm64'),'arm64-v8a');
  assert.equal(preferredAbi('x64',true),'arm64-v8a');
  assert.equal(preferredAbi('x64',false),'x86_64');
});
