# 34 — The editor's assistant: a sidebar that writes into the page

Original request: «refactor editor — right now we've got an ai pop-up window
that help writing documents, i want to refactor it — make it a togglable
sidebar on the left, dynamic animated text updates like on notion,
functionality similar to assistant page»

## What

- **A panel on the left of the editor**, toggled from the header's Assistant
  button or `⌘J` / `Ctrl+J`. It is the assistant page's chat (`ChatPane`,
  mounted `embedded`): same composer, modes, agents, skills, models and threads,
  so nothing the assistant page can do is missing here.
- **It takes the navigation rail's place.** While open on an editor route the
  shell yields the rail (`meta.assistantPanel`); asking for the rail from the
  topbar closes the panel and brings the rail back as it was left. Below `lg`
  there is no rail to replace, so the panel is a drawer over the page.
- **It reads the draft, not the published page.** Every turn sent while the
  editor is mounted carries `draft: { title, markdown }` — unstaged edits
  included — and the prompt grounds the model in that instead of the head
  revision.
- **It writes into the page.** A new tool, `edit_draft(op, anchor, markdown)`,
  streams into the editor as the model writes its arguments. The text is a
  **suggestion**: marked in the gutter, with Keep / Discard under it, and a dock
  above the composer summarizing everything pending (`Keep all` = `⌘↵`).
- **Text arrives the way Notion's does.** Each newly revealed run resolves out
  of a violet blur into ink — in the page and in the chat reply alike
  (`lib/stream-reveal.ts`, class `.kn-reveal`).
- **The formatting toolbar and header fold down at narrow widths** instead of
  overflowing: the toolbar measures itself and moves groups into a "More" menu;
  below `sm` the header keeps the assistant, a "More actions" menu and Publish.

## Decisions

**A suggestion is document content that nothing persists.** Streaming into a
side buffer and swapping it in on accept would mean the author reads a preview
that is not how the page will render. So the text is real ProseMirror content
from the first token, and three things keep it provisional:
`serializeKept` in RichEditor (`withoutSuggestions` + `docToMarkdown`) is the one
serializer — the model binding, the working copy, a save's flush and the next
turn's draft all read it, so a pending suggestion reaches none of them; every
streaming step is `addToHistory: false`, so undo walks the author's own edits;
and each suggestion holds the exact slice it replaced, mapped through later
transactions, so Discard restores it byte for byte.

**Keep is the author's edit.** Because the text went in outside history, merely
dropping the markers would leave a kept paragraph ⌘Z cannot take back. Keep puts
the range back (outside history) and writes the kept slice over it as an
ordinary edit, in one tick — undo afterwards returns the page from before the
suggestion.

**Streaming tool arguments.** `AssistantClient.createStream` already reassembled
tool-call fragments; it now also hands them to an optional `toolArgs` callback.
`partial-args.ts` reads the top-level string values of a half-written JSON
object (only ever growing, escape-safe), and `AssistantService.draftPreviewer`
emits a `draft-edit` frame once `op` is known and — for anchored ops — the
anchor has fully arrived, then at most every 60 ms. Every frame carries the text
so far, so frames are idempotent and a dropped one costs nothing.

**The anchor is judged on execution, twice.** The server checks the quote
against the markdown it was sent (`draft-edits.ts`: exact, then
whitespace-folded; ambiguous is refused, not guessed) and tells the model how to
fix a bad one — the editor drops the preview on `rejected`. It then applies the
edit to its per-turn copy of the draft, so a second edit in the same turn is
checked against the page the first left behind. The editor resolves the same
quote against its rendered text (the comment-anchor projection), falling back to
head and tail words when a mention or embed renders differently.

**Block-level.** An edit replaces or sits beside whole top-level blocks. That is
the unit an author accepts, the one a markdown quote can find again in a rich
document, and it keeps the preview's DOM churn to the paragraph being written:
unchanged leading blocks are kept by identity.

**Not a write.** `edit_draft` changes nothing server-side, so it is offered in
Ask mode too, is not in `ASSISTANT_WRITE_TOOL_NAMES`, costs no tool budget
(`FREE_TOOLS`), and is offered only on a streamed turn that sent a draft — on the
assistant page it is inert. It is serial, not parallel-safe: each edit is
checked against the last.

**Publishing with undecided suggestions is refused**, with the dock opened and
the first suggestion scrolled into view. Publishing would otherwise drop them
silently, which is the one outcome nobody chose.

**Violet, not indigo.** Machine authorship already wears the important-panel
violet (the AI avatar, the bot glyph). The assistant's writing does too, as a
1px gutter rule and the reveal's starting color; indigo stays the structure
accent. Under `prefers-reduced-motion` the panel crossfades, the reveal is
dropped, and the gutter alone marks new text.

**Open state is a cookie** (`kn_aipanel`, unset = closed), read during SSR like
the rail's, because while it is open the rail is not — a page that painted the
rail and then swapped it would do so on every load.

**Threads.** Opening the panel reopens the most recent chat about this page
(`openForDocument`), or starts blank; "New chat" is `startBlank()`, so a thread
exists only once something is sent. Rename/delete dialogs moved into
`ThreadDialogs.vue`, shared with the assistant page.

## Not done

- Inline (selection) prompts — "rewrite this paragraph" from the bubble menu.
  The panel can do it by quoting; an inline entry point is the natural follow-up.
- Word-level diff inside a replaced block. Replace shows the new block only; a
  deletion shows what would go under its action bar.
- A suggestion survives only in the tab it was made in. By design it is never
  written to the working copy.
