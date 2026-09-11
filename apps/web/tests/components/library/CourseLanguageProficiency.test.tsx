// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { CourseLanguageProficiency } from '../../../components/library/CourseLanguageProficiency';

test('binds proficiency to the course language and allows an undeclared level', () => {
  const onChange = vi.fn();
  const { rerender } = render(<CourseLanguageProficiency language="English" onChange={onChange} />);
  const input = screen.getByRole('combobox');
  expect(input).toHaveValue('');
  fireEvent.change(input, { target: { value: 'B2' } });
  expect(onChange).toHaveBeenLastCalledWith({ language: 'English', level: 'B2' });
  rerender(
    <CourseLanguageProficiency
      language="English"
      value={{ language: 'English', level: 'B2' }}
      onChange={onChange}
    />
  );
  fireEvent.change(input, { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith(undefined);
  rerender(
    <CourseLanguageProficiency
      language="Italiano"
      value={{ language: 'English', level: 'B2' }}
      onChange={onChange}
    />
  );
  expect(input).toHaveValue('');
});
