import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveMessageType } from '../../lib/messageType.js';
import { messageDisplayText } from '../../lib/postExtras.js';

const file = (type: string, name = 'f') => ({ type, name });

test('URL-only is a Link; a URL in a sentence is Text', () => {
  assert.equal(deriveMessageType({ content: 'https://velo.app/x' }), 'Link');
  assert.equal(deriveMessageType({ content: 'see https://velo.app' }), 'Text');
});

test('text defaults to Text, Markdown only on request, and a claimed Link is ignored', () => {
  assert.equal(deriveMessageType({ content: 'hi' }), 'Text');
  assert.equal(deriveMessageType({ content: '**hi**', requested: 'Markdown' }), 'Markdown');
  assert.equal(deriveMessageType({ content: 'hi', requested: 'Link' }), 'Text');
  assert.equal(deriveMessageType({ attachments: [file('image/png')], requested: 'Poll' }), 'Poll');
});

test('attachment-only messages are typed by their kind', () => {
  assert.equal(deriveMessageType({ attachments: [file('image/png'), file('image/gif')] }), 'Image');
  assert.equal(deriveMessageType({ attachments: [file('video/mp4')] }), 'Video');
  assert.equal(deriveMessageType({ attachments: [file('audio/mpeg', 'a.mp3')] }), 'Audio');
  assert.equal(deriveMessageType({ attachments: [file('audio/mpeg', 'voice-note-1-5s.mp3')] }), 'VoiceNote');
  assert.equal(deriveMessageType({ attachments: [file('image/png'), file('application/pdf')] }), 'File');
  assert.equal(deriveMessageType({ content: 'cap', attachments: [file('image/png')] }), 'Text');
});

test('empty attachment messages get a readable preview', () => {
  assert.equal(messageDisplayText('VoiceNote', ''), '🎤 Voice message');
  assert.equal(messageDisplayText('Image', undefined), '📷 Photo');
  assert.equal(messageDisplayText('Text', 'hello'), 'hello');
});
