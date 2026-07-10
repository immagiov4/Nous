import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE,
  getActivePauseExerciseLabel,
  normalizeActivePauseExerciseType,
} from '../../../utils/learning/activePause.ts';

test('normalizeActivePauseExerciseType keeps legacy pauses compatible', () => {
  assert.equal(normalizeActivePauseExerciseType(undefined), DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE);
  assert.equal(normalizeActivePauseExerciseType('unknown'), DEFAULT_ACTIVE_PAUSE_EXERCISE_TYPE);
  assert.equal(normalizeActivePauseExerciseType('prediction'), 'prediction');
});

test('getActivePauseExerciseLabel localizes generated pause types', () => {
  assert.equal(
    getActivePauseExerciseLabel({ exerciseType: 'error-diagnosis' }, 'it'),
    'Diagnosi errore'
  );
  assert.equal(getActivePauseExerciseLabel({}, 'en'), 'Concept check');
});
