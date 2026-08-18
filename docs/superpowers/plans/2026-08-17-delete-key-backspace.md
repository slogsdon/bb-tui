# Delete Key Backspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore backward deletion for the Mac and iPad Delete key.

**Architecture:** Keep input normalization in the pure composer model. Route both Ink erase flags through the existing `eraseBefore` function while retaining raw erase-byte handling.

**Tech Stack:** TypeScript 5.7, Ink 5.2, Node test runner via `tsx`.

## Global Constraints

- Both `key.backspace` and `key.delete` erase the character before the cursor.
- Raw `0x7f` and `0x08` bytes retain backward-erase behavior.
- Forward deletion is unsupported at Ink's `useInput` boundary.
- Do not change unrelated composer, cursor, or rendering behavior.

---

### Task 1: Normalize Ink erase flags

**Files:**
- Modify: `client/src/composer.test.ts:32-35`
- Modify: `client/src/composer.ts:52-62`

**Interfaces:**
- Consumes: `applyKey(state: Composer, data: string, key: KeyFlags): Composer`
- Produces: backward deletion for `KeyFlags.backspace` and `KeyFlags.delete`

- [ ] **Step 1: Write the failing regression test**

Replace the existing combined erase test with literal expectations for the physical-key behavior:

```typescript
test("Ink backspace and delete flags both erase before the cursor", () => {
  assert.deepEqual(applyKey(at("abc", 2), "", { backspace: true }), { text: "ac", cursor: 1 });
  assert.deepEqual(applyKey(at("abc"), "", { delete: true }), { text: "ab", cursor: 2 });
  assert.deepEqual(applyKey(at("abc", 2), "", { delete: true }), { text: "ac", cursor: 1 });
});
```

- [ ] **Step 2: Run the targeted test to verify RED**

Run: `npx tsx --test --test-name-pattern="Ink backspace and delete" src/composer.test.ts`

Expected: FAIL because `{delete: true}` at the end returns `abc`, and in the middle removes the character at the cursor instead of the preceding character.

- [ ] **Step 3: Implement the minimal normalization**

Replace the separate flag branches in `applyKey` with:

```typescript
if (key.backspace || key.delete) return eraseBefore(state);
```

- [ ] **Step 4: Verify targeted and adjacent behavior**

Run: `npx tsx --test --test-name-pattern="Ink backspace and delete|erase bytes|cursor movement" src/composer.test.ts`

Expected: all selected tests pass, including raw-byte deletion and cursor clamping.

- [ ] **Step 5: Run the complete verification gate**

Run from `client/`:

```bash
npm test
npm run typecheck
```

Run from the repository root:

```bash
bb plugin build bb-plugin-bb-tui
```

Expected: all tests pass, typecheck exits zero, and the plugin build emits `dist/server.js`, `dist/server.js.map`, and `dist/server.meta.json`.

- [ ] **Step 6: Commit the regression fix**

Stage only the implementation files:

```bash
git add client/src/composer.test.ts client/src/composer.ts
git commit -m "fix(tui): restore Delete key backspace"
```
