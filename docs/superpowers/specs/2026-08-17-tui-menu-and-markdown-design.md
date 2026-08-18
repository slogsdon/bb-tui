# TUI Command Menu and Markdown Rendering Design

## Scope

Fix two reproduced UI defects without changing unrelated behavior:

1. A command-menu selection can move beyond the six rendered entries and disappear off screen.
2. Authored Markdown paragraph breaks are not visibly preserved in the rendered transcript.

The command-menu work also establishes one consistent focus-border rule: exactly one keyboard target has a cyan border, and every inactive border is muted gray.

## Command Menu

The menu keeps its existing six-entry cap. It renders a contiguous window of the full match list whose start index follows the selection only when the selection would otherwise leave the viewport. The window clamps at the beginning and end of the list. Filtering or changing the slash token continues to reset selection to the first match.

The visible window, not the full list prefix, determines section headers and menu height. The border occupies two additional rows, which are reserved from transcript height so the menu cannot overlap or overflow adjacent content.

Focus borders follow these states:

- List focused: list border cyan; detail, menu, and composer borders muted.
- Composer focused with no open menu: composer border cyan; all others muted.
- Command menu open: menu border cyan; composer and all others muted.

The menu uses a single-line border. Existing outer pane geometry and the six-entry limit remain unchanged.

## Markdown Paragraphs

The renderer preserves exactly one terminal blank row for each authored Markdown paragraph break. Consecutive source blank lines collapse to one row, and leading or trailing blank rows remain omitted. The renderer does not invent spacing where the Markdown source has no paragraph break.

The fix must occur at the boundary that drops the already-produced blank Markdown line. Parser behavior that already passes its unit tests remains unchanged unless the failing end-to-end render test proves it is the dropping boundary.

## Verification

Regression tests will first demonstrate the current failures:

- With more than six matches, moving the selection past the first viewport keeps the selected entry visible and moves earlier entries out of view.
- Moving back to the start and selecting the final entry clamps the menu viewport correctly.
- Menu-open focus renders one cyan menu border while the composer and pane borders are muted.
- A transcript containing the exact multi-paragraph Markdown shape from the reported response renders one blank terminal row between paragraphs.

Critic checks cover a list shorter than six entries, command/skill section boundaries, filtered matches, narrow panes, transcript scrolling, empty content, and menu close/open focus transitions. Final verification runs the full client test suite, client typecheck, and plugin build. The repository defines no lint command.
