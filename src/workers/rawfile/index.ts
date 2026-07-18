/**
 * Write-ahead raw day-file submodule (bridge 01.5) — 002's slice: per-append
 * framing + the group-commit fsync'd append writer that realizes RAW_APPEND_PORT.
 */
export * from './framing';
export * from './file-writer';
export * from './raw-file.service';
