# Chat streaming
- [x] Stream model text and reasoning throughout every tool step.
- [x] Show reasoning and tool activity in the existing COT panel.
- [x] Verify incremental SSE and live datetime + shell tool continuation (103 deltas, both tools completed).
- [x] Verify isolated COT rendering: tools are collapsed by default and show command/output when expanded.
- [ ] Verify the full visible chat: blocked by browser rendering stalls in the uploaded page.- [x] Current time always in model context (system prompt)
- [x] InstaVM tools: shell, python, Nix install, files, public port URL, browser
- [ ] Remaining InstaVM features from uploaded list (snapshots, clones, volumes, vaults, PTY): not wired as chat tools yet
