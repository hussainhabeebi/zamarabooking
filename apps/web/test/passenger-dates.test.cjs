const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const file = path.resolve(__dirname, '../app/lib/passenger-dates.ts');
const mod = new Module(file, module);
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const { isCalendarDate, dateOnly, dateProblem, passengerDatesProblem } = mod.exports;
const today = '2026-10-30';
test('rejects oversized years, incomplete dates and impossible calendar dates', () => {
  for (const value of ['222222-04-23', '10000-01-01', '+002026-10-30', '0000-01-01', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01', 'not a date']) assert.equal(isCalendarDate(value), false, value);
});
test('validates leap years without calendar rollover', () => {
  for (const value of ['2000-02-29', '2024-02-29', '0001-01-01', '9999-12-31']) assert.equal(isCalendarDate(value), true, value);
  assert.equal(isCalendarDate('1900-02-29'), false);
});
test('DOB is past, issue is not future and expiry is future', () => {
  assert.equal(dateProblem('2026-10-29', 'birth', today), null);
  assert.ok(dateProblem(today, 'birth', today));
  assert.ok(dateProblem('2026-10-31', 'birth', today));
  assert.equal(dateProblem(today, 'issue', today), null);
  assert.ok(dateProblem('2026-10-31', 'issue', today));
  assert.ok(dateProblem(today, 'expiry', today));
  assert.ok(dateProblem('2026-10-29', 'expiry', today));
  assert.equal(dateProblem('2026-10-31', 'expiry', today), null);
});
test('optional dates stay optional but malformed imported/scanned values cannot pass', () => {
  assert.equal(passengerDatesProblem({}, today), null);
  assert.ok(passengerDatesProblem({ passportExpiry: '222222-04-23' }, today));
  assert.ok(passengerDatesProblem({ dob: '2026-02-30' }, today));
  assert.equal(passengerDatesProblem({ dob: '1990-01-01T00:00:00Z', passportExpiry: '2030-04-23' }, today), null);
});
test('timestamp normalization never hides an oversized year', () => {
  assert.equal(dateOnly('2030-04-23T00:00:00Z'), '2030-04-23');
  assert.equal(dateOnly('222222-04-23'), '222222-04-23');
  assert.equal(dateOnly('222222-04-23T00:00:00Z'), '222222-04-23T00:00:00Z');
  assert.equal(dateOnly(null), '');
});
