import { parseArgs, strictFlag } from '../../src/mvp/cli';

describe('MVP CLI arguments', () => {
  test('accepts a valueless explicit approval flag', () => {
    expect(strictFlag(parseArgs(['continue', '--approve-plan']), 'approve-plan')).toBe(true);
  });

  test('does not treat a false string as approval', () => {
    expect(() =>
      strictFlag(parseArgs(['continue', '--approve-plan', 'false']), 'approve-plan')
    ).toThrow('--approve-plan does not accept a value');
  });
});
