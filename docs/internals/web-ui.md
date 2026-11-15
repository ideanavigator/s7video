# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#taste) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.
- Consumers are a few lines of slots, and the slots carry the banner styling:
  [`ComposerPlanFollowUpBanner.tsx`](../../apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx).

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Handlers in large components

V8 gives every closure created in one render a single shared scope. A memoized handler keeps
the scope of the render that created it, and that scope holds the other memoized values of that
render. When handlers in one component change at different times, each keeps an older scope that
holds older handlers, and old renders, with their server config and thread data, stay in memory
for as long as the component is mounted. React Compiler's memoized closures do the same.

In large, long-lived components such as `ChatView` and `ChatComposer`, write handlers as plain
functions and wrap them with [`useStableCallback`](../../apps/web/src/hooks/useStableCallback.ts)
only where they leave the component: props, hook dependency arrays, and effect or memo bodies.
Calls inside the component keep the plain function, so work that resumes after an `await` still
acts on the render it started in. A function that a child calls during render, or after an
`await`, comes from a module-level factory memoized on its inputs, so its closure keeps only
those inputs.

## React Compiler

The compiler memoizes a component or hook only when it can prove the code follows React's rules.
Anything it can't prove, such as reading a ref during render or calling `setState` from an effect,
makes it skip the whole function without a build error. Lint reports each skip as a
`react(...)` warning with the note "React Compiler skipped optimizing this component or hook".

Every file under `apps/web/src` must compile. Lint makes those rules errors there, and
`t3code/no-manual-memo` rejects `useMemo` and `useCallback`, which the compiler makes redundant;
no upstream rule bans them outright. It also rejects `"use memo"`. The compiler withholds a cache
scope when a value reaches plain function calls on both sides of a hook call. A `"use memo"`
helper forces one, but hides the ordering problem. Fix the order instead: plain uses of a value go
before the hook, or the helper is inlined. A `use*` helper that calls no hook is compiled as a
plain function and caches nothing, so a derived-value helper reads its source hook itself instead
of taking the value as an argument. `t3code/no-hookless-use-function` rejects a `use*` function
that calls no hook. Lint misses some bailouts, notably `try` with `finally` and
`throw` inside `try`, so [`reactCompilerCoverage.test.ts`](../../apps/web/src/reactCompilerCoverage.test.ts)
compiles every file and fails on any skip. Async handlers rarely need `try`: an
atom command settles into a result, so cleanup can follow the `await`. `useStableCallback` still
marks handlers that leave a large component, as described above.

## Video-project layout

A project is a video project when its edit loads (`useIsVideoProject`); the web app has no other
signal. A thread there opens with the Editor in the right panel at 60% of the workspace, within the
usual caps ([`videoProjectLayout.ts`](../../apps/web/src/editor/videoProjectLayout.ts)). The
default applies only to a thread with no saved panel state, no hidden panel and no panel choice
this session. It sets `editorOpenedByDefault`, which keeps the thread's entry after the user
closes every tab, so a closed Editor stays closed after a reload. Proactive panels never take the
active tab from the Editor, and a chat link to a clip in Media plays it in the Editor
([`clipLinks.ts`](../../apps/web/src/editor/clipLinks.ts)). Other projects keep T3's layout.

The player gets space first (UX guide rule 3, S7V-101). Its box follows the canvas shape, and its
picture never gets shorter than `PLAYER_SHARE` (45%) of the Editor's height (`playerRoomPx` in
`EditorPanel.tsx`), at 1180x760 too. A 16:9 picture in a narrow Editor fills the width instead,
and its area still keeps the share. Above it come the header, the export row and the notices,
with a refused change first; the speech-model prompt is one line. Only whole notices show
(`fitNotices` in `EditorPanel.tsx`, from their measured heights): as many as fit while the
timeline keeps its video row (`TIMELINE_FLOOR_PX`), the refusal always. The rest wait behind
"Show N more notices". Opening always shows at least the next whole notice and moves focus to
it; the notices may take the timeline down to its toolbar and ruler (`TIMELINE_SHORTEST_PX`),
and when even then the next notice can't sit beside the ones shown, it takes their place. A
28 px "Show fewer notices" button stays beside the opened notices, with a count of any still
left out. Opened belongs to the notices it opened: a new notice closes them again. A notice out
of view is clipped at a notice boundary and `inert`, so Tab never reaches it. Below the player, the tabs show whole version rows
(`TAB_ROW_PX`), or, when not even one row fits, the tab bar ends with one plain line: "Close a
notice above or make the window taller to see Versions." while something above can be closed,
else "Make the window taller to see Versions.". The tabs get a row only when the timeline can
still keep its floor (`TIMELINE_FLOOR_PX` in `TimelinePane.tsx`: toolbar, ruler and video row).
The timeline is clamped so the column always ends inside the panel; in the shortest panel it
keeps only its toolbar and ruler, and its rows scroll. A saved timeline height still applies
wherever it fits.
