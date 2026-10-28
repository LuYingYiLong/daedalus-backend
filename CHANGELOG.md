# Daedalus Backend Changelog

## Unreleased

### Fixed
- Added stable conversation routing headers and a Daedalus user agent for OpenCode Go requests

## [1.4.5] - 2026-10-27

### Added
- Added read-only Chat session search and reference tools for Agent context
- Added nonblocking Agent follow-up questions and assistant response feedback
- Updated the provider catalog with GPT-6 and Kimi K3 models and added DeepSeek web search support
- Added editable plan drafts and streaming updates

### Changed
- Stabilized model prompt layout for better cache reuse and expanded cache usage diagnostics
- Hardened terminal sandbox command launching and added generic runtime environment preflight

### Compatibility
- Backend protocol remains v3 and Bridge protocol compatibility remains v4
