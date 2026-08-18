# Delete Key Backspace Regression

## Problem

Ink 5 maps the `0x7f` byte emitted by the Mac and iPad Delete key to
`key.delete`. The cursor-aware composer currently treats that flag as forward
delete. Pressing Delete at the end of `abc` therefore leaves `abc` unchanged;
before the cursor-aware composer was introduced, both Ink erase flags removed
the preceding character.

## Design

Normalize both `key.backspace` and `key.delete` to the composer's existing
`eraseBefore` operation. Keep the existing handling for raw `0x7f` and `0x08`
bytes unchanged. This restores the behavior at the pure input-model boundary,
so it applies consistently in the message composer and every other view that
uses `applyKey`.

Ink's `useInput` API does not distinguish the Mac/iPad Delete key from a
forward-delete input once both have become `key.delete`. Forward deletion is
therefore intentionally unsupported at this boundary; both flags erase
backward.

## Verification

Replace the existing forward-delete expectation with regression cases proving
that `key.delete` removes the character before the cursor both at the end of
text and in the middle. Retain the existing `key.backspace` and raw-byte cases.
Run the targeted composer tests, the complete client test suite, typecheck, and
the plugin build.
