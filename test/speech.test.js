import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptOf, mergeSpeech } from '../web/js/lib/speech.js';

const R = (...items) => items.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: !!f }));

test('Android: cumulative results are not repeated', () => {
  // What Android Chrome sends while you say "remind me to post the short tonight"
  const results = R(['remind', true], ['remind me', true], ['remind me to post', true], ['remind me to post the short', true], ['remind me to post the short tonight', false]);
  assert.equal(transcriptOf(results), 'remind me to post the short tonight');
});

test('Android: a repeated final result does not double the text', () => {
  assert.equal(transcriptOf(R(['check my tiktok stats', true], ['check my tiktok stats', true])), 'check my tiktok stats');
});

test('desktop: separate pieces are joined once', () => {
  assert.equal(transcriptOf(R(['check my youtube', true], [' and reply to comments', true], [' today', false])), 'check my youtube and reply to comments today');
});

test('overlapping pieces join on the overlap', () => {
  assert.equal(mergeSpeech('post the short', 'the short tonight'), 'post the short tonight');
  assert.equal(mergeSpeech('Hello there.', 'hello there'), 'Hello there.');
});
