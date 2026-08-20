# Daedalus native plugin fixture

This package is a safe local fixture for validating the P1 plugin runtime. In Daedalus Studio, open **Settings → Plugins → Add → Local directory** and select this folder.

After scanning, trust the package explicitly. It registers one read-only echo tool, one Skill, one `SessionStart` Hook, and one read-only MCP tool. The fixture has no dependencies and does not execute install scripts.
