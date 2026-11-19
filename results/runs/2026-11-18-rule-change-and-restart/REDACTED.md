# Personal details removed

This run was recorded on the computer of the person who ran it. Before publication, `scripts/redact-results.mjs` replaced the user name in paths with `owner`, replaced the private temporary folder with `xx/redacted`, and dropped the names of MCP servers and MCP tools from the lists that hold them. Nothing else was changed.

The ledger is hash chained, so the published ledger is a new chain: every entry from the first changed one on has a new hash, changed blobs are stored under their new hash, and the anchors follow. A signed receipt was signed again with a key made for the redaction. The published copy is tamper-evident from the redaction on. It is not the file the daemon wrote. That person keeps the original files, and the old heads and keys below match them.

- `ledger.jsonl`: head sha256:adaabd63ec945449a8814cbffa09fa92c1810a189f62bf478e76be1539af959b is now sha256:d893fdd383cf4d5675d4629efd6a739e2d57ca85eb353137a4db675c7cde81e2
- `receipt/ledger.jsonl`: head sha256:adaabd63ec945449a8814cbffa09fa92c1810a189f62bf478e76be1539af959b is now sha256:d893fdd383cf4d5675d4629efd6a739e2d57ca85eb353137a4db675c7cde81e2
- `receipt/receipt.json`: signing key sha256:266489ab1e27fe5165e1e4783d126488ddce9dd2703978dc01db8e782f4cb0bb is now sha256:27733595accf0c79b3312b463804f19c03b69c1e85b6c48331e718759f39acad
