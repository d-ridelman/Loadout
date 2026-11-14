<!-- ctxkit:start -->
## Model Team & Context Discipline (ctxkit)

- Main session runs on **sonnet**. Consult **advisor (fable)** before locking a non-trivial plan, when the same error repeats twice, and before calling work done.
- Delegate codebase search, grep, and docs reading to `Explore` (haiku). Keep tiny 1-2 file fixes local; run `checker` (Opus) before finishing non-trivial changes.
- Batch independent `Read`/`Edit` calls and browser steps (`browser_batch`, `browser_snapshot` with `interactive_only: true` and `viewport_only: true`).
- Do not load long files whole: locate symbols via `Grep`/LSP first, then read tight line ranges. Run `ctxkit check <cmd>` for build, test, and lint when full verbose logs are not needed.
- Clear finished tasks with `/clear` instead of dragging sessions past ~100-150 turns.
<!-- ctxkit:end -->
