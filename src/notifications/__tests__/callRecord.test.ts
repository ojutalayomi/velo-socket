import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCallRecord, callOutcome, callPreview, parseCallRecord } from '../../lib/callRecord.js';
import { messageDisplayText } from '../../lib/postExtras.js';

const base = { callType: 'audio' as const, callerId: 'u1', peakParticipants: 2 };

test('a connected call is completed with its talk time', () => {
  const record = buildCallRecord({ ...base, status: 'connected', connectedAt: 1_000 }, 66_400);
  assert.deepEqual(record, { callType: 'audio', outcome: 'completed', durationSec: 65, participants: 2, callerId: 'u1' });
});

test('unanswered calls are missed; a callee hang-up is declined', () => {
  assert.equal(callOutcome({ status: 'ringing' }), 'missed');
  assert.equal(callOutcome({ status: 'declined' }), 'declined');
  assert.equal(buildCallRecord({ ...base, status: 'ringing', peakParticipants: 1 }, 5000).durationSec, 0);
});

test('parseCallRecord rejects anything that is not a call record', () => {
  assert.equal(parseCallRecord('not json'), null);
  assert.equal(parseCallRecord(JSON.stringify({ callType: 'x', outcome: 'missed', callerId: 'u' })), null);
  const ok = parseCallRecord(JSON.stringify({ callType: 'video', outcome: 'missed', callerId: 'u', durationSec: -3 }));
  assert.equal(ok?.durationSec, 0);
});

test('previews read as text, not JSON', () => {
  const done = { callType: 'video' as const, outcome: 'completed' as const, durationSec: 125, participants: 3, callerId: 'u' };
  assert.equal(callPreview(done), '📞 Video call · 2m 5s');
  assert.equal(callPreview({ ...done, outcome: 'missed', durationSec: 0 }), '📞 Missed video call');
  assert.equal(messageDisplayText('Call', JSON.stringify(done)), '📞 Video call · 2m 5s');
});
