# Personal details removed

This run was recorded on the computer of the person who ran it. Before publication, `scripts/redact-results.mjs` replaced the user name in paths with `owner`, replaced the private temporary folder with `xx/redacted`, and dropped the names of MCP servers and MCP tools from the lists that hold them. Nothing else was changed.

The ledger is hash chained, so the published ledger is a new chain: every entry from the first changed one on has a new hash, changed blobs are stored under their new hash, and the anchors follow. A signed receipt was signed again with a key made for the redaction. The published copy is tamper-evident from the redaction on. It is not the file the daemon wrote. That person keeps the original files, and the old heads and keys below match them.

- `ledger.jsonl`: head sha256:9a303353c0cab91480656d193d203d7771ccb1a995240b3d3f6afb45fc0b806b is now sha256:b3df5b8a24017d28a1354a2424843e3a7e9272dda7c15f547f0ecd8d6a21e2fe
- `receipt/ledger.jsonl`: head sha256:9a303353c0cab91480656d193d203d7771ccb1a995240b3d3f6afb45fc0b806b is now sha256:b3df5b8a24017d28a1354a2424843e3a7e9272dda7c15f547f0ecd8d6a21e2fe
- `receipt/receipt.json`: signing key sha256:38f2afd496f915f99d8d470462408d87d7f3f773d7f333ec263a58afc8f767b7 is now sha256:27733595accf0c79b3312b463804f19c03b69c1e85b6c48331e718759f39acad
