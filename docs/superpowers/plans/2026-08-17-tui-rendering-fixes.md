# TUI Rendering Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep slash-menu selection visible with unambiguous focus borders and preserve authored Markdown paragraph breaks in the Ink transcript.

**Architecture:** Store slash-menu selection and viewport start as one state value, update both through a pure clamped transition, and render the resulting six-entry window inside a bordered Ink box. Preserve Markdown blank rows at the Ink layout boundary by giving blank transcript rows explicit one-row boxes; the Markdown parser remains unchanged.

**Tech Stack:** TypeScript, React 18, Ink 5, Node's `node:test`, `tsx`, and `tsc`.

## Global Constraints

- Fix only the two reproduced defects and the approved focus-border behavior; do not refactor unrelated code.
- Keep at most six menu entries visible.
- Exactly one keyboard target has a cyan border; inactive borders use dim gray.
- Preserve exactly one terminal row for an authored Markdown paragraph break; do not synthesize breaks absent from the source.
- Use failing behavioral tests before production changes.
- Keep the two bug fixes as separate conventional commits and stage explicit paths only.
- The repository has no lint command; final gates are client tests, client typecheck, and plugin build.

---

### Task 1: Scroll the command menu and expose focus

**Files:**
- Modify: `client/src/commands.ts`
- Modify: `client/src/commands.test.ts`
- Modify: `client/src/index.tsx`
- Modify: `client/src/layout.tsx`
- Modify: `client/src/layout.test.tsx`

**Interfaces:**
- Produces: `MenuSelection = { selected: number; firstVisible: number }`.
- Produces: `INITIAL_MENU_SELECTION: MenuSelection`.
- Produces: `moveMenuSelection(state, delta, entryCount, visibleCount): MenuSelection`.
- Produces: `MENU_MAX_ENTRIES = 6` from `commands.ts`, consumed by input state and layout.
- Changes `ThreadPaneProps.menu` to carry `entries`, `selected`, and `firstVisible`.

- [ ] **Step 1: Add failing viewport-transition tests**

Add to `client/src/commands.test.ts`:

```ts
test("menu selection scrolls only when it leaves the six-entry viewport", () => {
  let state = INITIAL_MENU_SELECTION;
  for (let index = 0; index < 6; index += 1) {
    state = moveMenuSelection(state, 1, 10, MENU_MAX_ENTRIES);
  }
  assert.deepEqual(state, { selected: 6, firstVisible: 1 });

  state = moveMenuSelection(state, -1, 10, MENU_MAX_ENTRIES);
  assert.deepEqual(state, { selected: 5, firstVisible: 1 });
});

test("menu selection clamps its viewport at both list ends", () => {
  assert.deepEqual(moveMenuSelection({ selected: 0, firstVisible: 0 }, -1, 10, 6), {
    selected: 0,
    firstVisible: 0,
  });
  assert.deepEqual(moveMenuSelection({ selected: 8, firstVisible: 4 }, 1, 10, 6), {
    selected: 9,
    firstVisible: 4,
  });
});
```

Import the four named menu-state exports from `commands.ts`.

- [ ] **Step 2: Add failing menu render and focus-border tests**

In `client/src/layout.test.tsx`, render `ThreadPane` with ten skill entries, `selected: 7`, and `firstVisible: 2`. Assert the stripped frame contains `skill-7`, omits `skill-0`, and contains two single-line boxes (menu plus composer). Add a raw-frame helper that does not strip ANSI and assert the menu border begins under cyan (`\u001B[36m`) while the composer border begins under gray (`\u001B[90m`).

Also render `WorkspaceLayout` with list focus and assert the list's round border is cyan while the detail and composer borders are gray. Derive expected escape sequences from Ink's actual baseline output; do not snapshot an entire frame.

- [ ] **Step 3: Run the targeted tests and confirm RED**

Run from `client/`:

```bash
npx tsx --test src/commands.test.ts src/layout.test.tsx
```

Expected: command tests fail because the menu-state exports do not exist; layout tests fail because only the first six entries render, the menu has no border, and the composer stays cyan while the menu is open.

- [ ] **Step 4: Implement the pure clamped menu transition**

In `client/src/commands.ts`, add:

```ts
export const MENU_MAX_ENTRIES = 6;

export type MenuSelection = {
  selected: number;
  firstVisible: number;
};

export const INITIAL_MENU_SELECTION: MenuSelection = { selected: 0, firstVisible: 0 };

export function moveMenuSelection(
  state: MenuSelection,
  delta: number,
  entryCount: number,
  visibleCount = MENU_MAX_ENTRIES,
): MenuSelection {
  const last = Math.max(0, entryCount - 1);
  const selected = Math.max(0, Math.min(last, state.selected + delta));
  const size = Math.max(1, visibleCount);
  const maxFirst = Math.max(0, entryCount - size);
  let firstVisible = Math.max(0, Math.min(maxFirst, state.firstVisible));
  if (selected < firstVisible) firstVisible = selected;
  else if (selected >= firstVisible + size) firstVisible = selected - size + 1;
  return { selected, firstVisible };
}
```

- [ ] **Step 5: Wire the state transition into keyboard input**

In `client/src/index.tsx`, replace `menuSel` with one `MenuSelection` state initialized from `INITIAL_MENU_SELECTION`. Reset the whole state when `tokenText` changes. Replace arrow handlers with:

```ts
setMenuSelection((state) =>
  moveMenuSelection(state, -1, menuMatches.length, MENU_MAX_ENTRIES),
);
```

and the corresponding `+1` transition. Accept `menuMatches[menuSelection.selected]`, and pass both state fields to `ThreadPane`.

- [ ] **Step 6: Render the selected viewport and reserve its bordered height**

In `client/src/layout.tsx`, import `MENU_MAX_ENTRIES` from `commands.ts`. Slice every visible menu calculation from `menu.firstVisible`:

```ts
const shown = menu.entries.slice(menu.firstVisible, menu.firstVisible + MENU_MAX_ENTRIES);
```

Compare selected rows using the absolute index `menu.firstVisible + index`. Make `menuHeight` return `shown.length + sectionCount + 2` for the two border rows. Wrap `SlashMenu` in a single-line cyan border and compute entry widths from the border's inner width.

- [ ] **Step 7: Apply the single-active-border rule**

Pass `focused={props.focus === "list"}` into `ThreadListPane`. Use `borderColor={focused ? "cyan" : "gray"}` and `borderDimColor={!focused}` for the list. Keep the thread-pane outer border gray and dim. In `ThreadPane`, derive `menuActive = props.menu !== undefined && menuRows > 0`; the composer uses cyan only when `focus === "detail" && !menuActive`, otherwise gray and dim. The menu owns cyan whenever rendered.

- [ ] **Step 8: Run targeted tests and confirm GREEN**

Run from `client/`:

```bash
npx tsx --test src/commands.test.ts src/layout.test.tsx
npm run typecheck
```

Expected: targeted tests pass, typecheck exits 0, and no warning appears.

- [ ] **Step 9: Critic-check menu edge cases**

Add or confirm assertions for zero entries, fewer than six entries, a visible window crossing the command/skill section boundary, selection at both ends, narrow width, menu dismissal restoring composer cyan, and reopening/resetting at index 0. Run the same targeted commands after any correction.

- [ ] **Step 10: Present the menu diff and proposed commit**

Run:

```bash
git diff --check
git diff -- client/src/commands.ts client/src/commands.test.ts client/src/index.tsx client/src/layout.tsx client/src/layout.test.tsx
```

Propose `fix(tui): keep command selection visible`. Do not stage or commit until approved; then stage exactly the five listed files.

---

### Task 2: Preserve Markdown paragraph rows through Ink

**Files:**
- Modify: `client/src/layout.tsx`
- Modify: `client/src/layout.test.tsx`

**Interfaces:**
- Consumes unchanged `MdLine` values from `renderBlocks`.
- Produces no new public API; only blank transcript rows receive explicit Ink geometry.

- [ ] **Step 1: Add the failing transcript-layout test**

Import `renderBlocks` in `client/src/layout.test.tsx`. Render a `ThreadPane` whose details come from:

```ts
renderBlocks(
  [
    {
      role: "agent",
      text: "First paragraph.\n\nSecond paragraph.\n\n- item one\n- item two\n\nFinal paragraph.",
    },
  ],
  76,
);
```

Split the stripped frame into rows. Assert the row containing `Second paragraph.` is two positions after `First paragraph.`, and `Final paragraph.` is two positions after `• item two`. These expectations independently encode one visible blank terminal row.

- [ ] **Step 2: Run the targeted test and confirm RED**

Run from `client/`:

```bash
npx tsx --test src/layout.test.tsx
```

Expected: both row-distance assertions report `1` instead of `2`, demonstrating that Ink/Yoga gives `<Text> </Text>` zero height even though `renderBlocks` produced empty `MdLine` rows.

- [ ] **Step 3: Give blank transcript rows explicit geometry**

In the `visible.map` branch of `ThreadPane`, render empty `MdLine` values as a fixed row:

```tsx
line.spans.length === 0 ? (
  <Box key={from + index} height={1} flexShrink={0}>
    <Text> </Text>
  </Box>
) : (
  <Text key={from + index} wrap="truncate">
    {line.spans.map((span, spanIndex) => (
      <Text
        key={spanIndex}
        bold={span.bold}
        italic={span.italic}
        dimColor={span.dim}
        color={span.color}
      >
        {span.text}
      </Text>
    ))}
  </Text>
)
```

Do not change `markdown.ts`; its existing test already proves it collapses consecutive source blanks and removes leading/trailing blanks correctly.

- [ ] **Step 4: Run the targeted tests and confirm GREEN**

Run from `client/`:

```bash
npx tsx --test src/layout.test.tsx src/markdown.test.ts
npm run typecheck
```

Expected: both row-distance assertions pass, all Markdown parser tests remain green, and typecheck exits 0.

- [ ] **Step 5: Critic-check transcript geometry**

Verify empty transcript state, consecutive paragraphs, paragraph/list transitions, code fences, manual transcript scrolling, a menu open at the same time, and a short terminal height. Confirm each blank consumes exactly one of `visibleCount` rows and does not push the composer or menu outside the pane.

- [ ] **Step 6: Present the Markdown diff and proposed commit**

Run:

```bash
git diff --check
git diff -- client/src/layout.tsx client/src/layout.test.tsx
```

Propose `fix(tui): preserve Markdown paragraph spacing`. Do not stage or commit until approved; then stage exactly the two listed files.

---

### Task 3: Final verification and report

**Files:**
- Inspect only after Tasks 1 and 2 are committed.

**Interfaces:**
- Consumes both commits exactly as reviewed.
- Produces fresh verification evidence and the final user report.

- [ ] **Step 1: Run the full repository gates**

Run independently, using `client/` as the working directory for the first two commands and the repository root for the third:

```bash
npm test
npm run typecheck
bb plugin build bb-plugin-bb-tui
```

Expected: every client test passes with zero failures, client typecheck exits 0, and plugin build emits `dist/server.js`, `dist/server.js.map`, and `dist/server.meta.json`. Record that no lint command exists in either `package.json`.

- [ ] **Step 2: Inspect commit and worktree state**

Run:

```bash
git status --short --branch
git log --oneline -4
git show --stat --oneline HEAD
```

Expected: only the approved documentation and two fix commits are present, with no uncommitted production changes.

- [ ] **Step 3: Report each bug independently**

For the command menu, report reproduction, root cause (`slice(0, 6)` disconnected from selection), changed files, red/green tests, focus edge checks, and full-gate evidence. For Markdown, report reproduction, root cause (Ink/Yoga collapses space-only `Text` rows), changed files, red/green row-distance test, transcript edge checks, and full-gate evidence. Report any case that could not be reproduced instead of claiming it fixed.
