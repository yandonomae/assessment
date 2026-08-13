import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesWatch, looksLikeWordle, summarizeCapture } from '../src/capture.js';

const watch = { guildId: 'g1', channelId: 'c1' };

test('captures messages only in watched channel', () => {
  assert.equal(eventMatchesWatch('MESSAGE_CREATE', { guild_id: 'g1', channel_id: 'c1' }, watch), true);
  assert.equal(eventMatchesWatch('MESSAGE_CREATE', { guild_id: 'g1', channel_id: 'c2' }, watch), false);
});

test('captures voice events in watched guild', () => {
  assert.equal(eventMatchesWatch('VOICE_STATE_UPDATE', { guild_id: 'g1', channel_id: 'voice1' }, watch), true);
  assert.equal(eventMatchesWatch('VOICE_STATE_UPDATE', { guild_id: 'g2', channel_id: 'voice1' }, watch), false);
});

test('tags obvious Wordle-like payloads', () => {
  assert.equal(looksLikeWordle({ content: 'Wordle 1516 4/6' }), true);
  assert.equal(looksLikeWordle({ content: '⬛🟨⬛🟩⬛' }), true);
  assert.equal(looksLikeWordle({ content: 'hello' }), false);
});

test('summarizes applications and events', () => {
  const summary = summarizeCapture([
    { event: 'MESSAGE_CREATE', wordleCandidate: true, data: { application_id: 'app1', author: { id: 'u1', username: 'Wordle' } } },
    { event: 'MESSAGE_UPDATE', wordleCandidate: false, data: { application_id: 'app1', author: { id: 'u1', username: 'Wordle' } } }
  ]);
  assert.equal(summary.totalRecords, 2);
  assert.equal(summary.wordleCandidates, 1);
  assert.equal(summary.eventCounts.MESSAGE_CREATE, 1);
  assert.equal(summary.applicationIds.app1, 2);
});
