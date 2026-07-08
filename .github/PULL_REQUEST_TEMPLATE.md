<!--
Thanks for the PR! A quick checklist before review.
-->

## What & why
<!-- What does this change do, and why? Link an issue if there is one. -->

## Which path does this touch?
- [ ] Flat photo path (default — needs extra care)
- [ ] 3D mesh (`G`, experimental)
- [ ] Procedural face
- [ ] Voice loop
- [ ] Docs / repo
- [ ] Other

## Checklist
- [ ] Branch off `main`, flat-photo path still works.
- [ ] No build step or framework added (vanilla ES modules only).
- [ ] No secrets / API keys hardcoded.
- [ ] Tested on a few photos if touching photo/mesh paths.
- [ ] Commit history is clean (squash WIP if noisy).

## Notes for the reviewer
<!-- Anything non-obvious? Shader math, tuning constants, tradeoffs? -->
