import { describe, it, expect, beforeEach } from 'vitest';
import { ToolNameDeriver } from '../../src/compiler/tool-name-deriver.js';

describe('ToolNameDeriver', () => {
  let deriver: ToolNameDeriver;

  beforeEach(() => {
    deriver = new ToolNameDeriver();
  });

  it('converts a human-readable label to snake_case', () => {
    expect(deriver.derive('Submit Login Form')).toBe('submit_login_form');
  });

  it('truncates a very long label at the last word boundary before 64 characters', () => {
    // Construct a label whose snake_case form exceeds 64 characters
    // "one two three four five six seven eight nine ten eleven twelve thirteen" becomes
    // "one_two_three_four_five_six_seven_eight_nine_ten_eleven_twelve_thirteen" (71 chars)
    // Position 64 slice: "one_two_three_four_five_six_seven_eight_nine_ten_eleven_twelve_t"
    // Last _ before 64: position 62 (before 't' in 'thirteen')
    // Expected: "one_two_three_four_five_six_seven_eight_nine_ten_eleven_twelve"
    const label = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const result = deriver.derive(label);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result).toBe('one_two_three_four_five_six_seven_eight_nine_ten_eleven_twelve');
  });

  it('appends _2 for a second transition with the same label', () => {
    const first = deriver.derive('save draft');
    const second = deriver.derive('save draft');
    expect(first).toBe('save_draft');
    expect(second).toBe('save_draft_2');
  });

  it('appends _2 through _5 for five transitions with the same label', () => {
    const results = [
      deriver.derive('submit form'),
      deriver.derive('submit form'),
      deriver.derive('submit form'),
      deriver.derive('submit form'),
      deriver.derive('submit form'),
    ];
    expect(results).toEqual([
      'submit_form',
      'submit_form_2',
      'submit_form_3',
      'submit_form_4',
      'submit_form_5',
    ]);
  });

  it('returns "action" for an empty string input', () => {
    expect(deriver.derive('')).toBe('action');
  });

  it('returns "action" for input that reduces to empty after snake_case transform', () => {
    // A string of only non-alphanumeric characters strips to empty
    expect(deriver.derive('--- *** ---')).toBe('action');
  });

  it('reset() clears used names so the same name can be generated again', () => {
    deriver.derive('click button');
    deriver.reset();
    expect(deriver.derive('click button')).toBe('click_button');
  });
});
