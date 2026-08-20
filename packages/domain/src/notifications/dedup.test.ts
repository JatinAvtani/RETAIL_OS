import { describe, expect, it } from 'vitest';
import { resolveDedupAction } from './dedup';

describe('resolveDedupAction', () => {
  it('fires with no existing open notification -> CREATE', () => {
    const action = resolveDedupAction(true, null);
    expect(action).toEqual({ kind: 'CREATE' });
  });

  it('fires with an existing open notification -> UPDATE it in place, never a second CREATE', () => {
    const action = resolveDedupAction(true, { id: 'notif-1' });
    expect(action).toEqual({ kind: 'UPDATE', existingId: 'notif-1' });
  });

  it('does not fire, with an existing open notification -> RESOLVE it — the condition cleared', () => {
    const action = resolveDedupAction(false, { id: 'notif-1' });
    expect(action).toEqual({ kind: 'RESOLVE', existingId: 'notif-1' });
  });

  it('does not fire, with no existing open notification -> NO_OP, nothing to create or resolve', () => {
    const action = resolveDedupAction(false, null);
    expect(action).toEqual({ kind: 'NO_OP' });
  });
});
