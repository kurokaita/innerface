---
name: Mesh improvement
about: An experiment or fix for the experimental 3D mesh path
labels: mesh, help wanted
---

## The problem with the mesh
<!-- What's wrong with the `G` path on this image / in this case? -->

## Which known issue is this addressing?
- [ ] Depth accuracy (MediaPipe z is a guess)
- [ ] Noisy / faceted normals
- [ ] Backdrop ghosting on head turn
- [ ] "Masquerade mask" readability (eyes/mouth as voids)
- [ ] Washout on flat-lit photos
- [ ] Other:

## Approach
<!-- What's the idea? Depth model? G-buffer compositing? Normal smoothing? -->

## Does it touch the flat-photo path?
<!-- The flat path must keep working. Confirm isolation. -->
- [ ] No — isolated to the mesh branch
- [ ] Yes — explain why it can't be avoided

## Test images
<!-- Which photo types did you test on? Frontal / 3/4 / stylized / flat-lit / dramatic. -->
