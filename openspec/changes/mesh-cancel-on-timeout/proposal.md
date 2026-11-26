## Why
A mesh request that times out reports failure while its agent may keep working, leading to unobserved cost and possible effects after the failure notice.

## What Changes
Forward the existing timeout signal to the mesh agent session and check it before starting a turn after conversation lookup. Exercise the path using a synthetic provider and isolated filesystem.

## Impact
Changes the mesh handler, channel message and agent session adapter; no database migration or external interface change is required.
