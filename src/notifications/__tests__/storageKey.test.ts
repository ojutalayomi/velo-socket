import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uniqueStorageKey } from '../../lib/storageKey.js';

test('keeps the date folder and file name, adds a random id', () => {
  assert.equal(uniqueStorageKey('2026/26/11/photo.png', 'photo.png', 'abc'), '2026/26/11/abc-photo.png');
  assert.equal(uniqueStorageKey('voice.mp3', 'voice-note-1-3s.mp3', 'abc'), 'abc-voice-note-1-3s.mp3');
});

test('two uploads with the same name get different keys', () => {
  assert.notEqual(uniqueStorageKey('d/a.png', 'a.png'), uniqueStorageKey('d/a.png', 'a.png'));
});

test('a file name cannot add folders', () => {
  assert.equal(uniqueStorageKey('d/x', '../../etc/passwd', 'id'), 'd/id-.._.._etc_passwd');
});
