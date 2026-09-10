// @vitest-environment jsdom
import {
  type CoursePlanningControls,
  DEFAULT_COURSE_PLANNING_CONTROLS,
} from '@shared/coursePlanningControls';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { CourseControls } from '../../../components/library/CourseControls';

describe('course controls', () => {
  test('changes depth independently and returns to Auto', () => {
    const changed = vi.fn();
    function Harness() {
      const [controls, setControls] = useState<CoursePlanningControls>(
        DEFAULT_COURSE_PLANNING_CONTROLS
      );
      return (
        <CourseControls
          value={controls}
          hasReferenceMaterial
          onChange={next => {
            changed(next);
            setControls(next);
          }}
        />
      );
    }
    render(<Harness />);
    const depth = screen.getByRole('slider', { name: 'Approfondimento' });
    const granularity = screen.getByRole('slider', { name: 'Granularità' });
    expect(depth).toHaveValue('2');
    expect(granularity).toHaveValue('2');
    fireEvent.change(depth, { target: { value: '4' } });
    expect(changed).toHaveBeenLastCalledWith({ depth: 'much-more', granularity: 'auto' });
    expect(granularity).toHaveValue('2');
    fireEvent.change(depth, { target: { value: '2' } });
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_COURSE_PLANNING_CONTROLS);
    expect(depth).toHaveAccessibleDescription('Auto · Come il materiale');
  });

  test('changes the reference description when source availability changes', () => {
    const props = { value: DEFAULT_COURSE_PLANNING_CONTROLS, onChange: vi.fn() };
    const { rerender } = render(<CourseControls {...props} hasReferenceMaterial={false} />);
    expect(screen.getByRole('slider', { name: 'Approfondimento' })).toHaveAccessibleDescription(
      'Auto · Bilanciato'
    );
    rerender(<CourseControls {...props} hasReferenceMaterial />);
    expect(screen.getByRole('slider', { name: 'Approfondimento' })).toHaveAccessibleDescription(
      'Auto · Come il materiale'
    );
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
