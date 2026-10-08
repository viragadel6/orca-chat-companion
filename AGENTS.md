<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Chat integration
- Preserve the uploaded standalone HTML chat's DOM renderer and custom SSE protocol; it is not mounted in the bundled React tree, so AI Elements' npm/TSX primitives cannot be directly used here without replacing the user-supplied frontend. Scope this exception to the existing reasoning/tool panel.
- Decode provider SSE with the shared browser-safe incremental parser and accumulate indexed tool-call fragments before execution; this keeps real-time output separate from tool continuation.
