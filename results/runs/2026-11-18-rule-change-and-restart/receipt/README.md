# Receipt for run r_m4live

Record label: live. Written 2026-11-18T19:53:47.040Z (UTC).

Files in this folder:

- receipt.html: the receipt to read. Open it in a browser. It needs no network.
- receipt.json: the same receipt as data, signed with Ed25519.
- ledger.jsonl, anchors.jsonl, blobs: copies of the record the receipt names. They let verify check the chain without the machine that made it.

To check the receipt, run this in this folder:

    candor verify receipt.json --key-id sha256:27733595accf0c79b3312b463804f19c03b69c1e85b6c48331e718759f39acad

The key id above is the id of the key that signed this receipt. Get it from the issuer by another route than this folder. If the folder was forged, the id in it would be forged too. The id printed here comes from the same folder as the receipt, so check it against what the issuer told you. Without --key-id, verify cannot say who signed and exits with code 3.

Exit code 0 means every check passed. Exit code 1 means a check failed. Exit code 3 means a check was skipped. The command prints what it checked and what a pass does and does not show.

A pass is evidence that the receipt has not changed since it was signed and that the record has not changed since it was anchored. It does not show that the run was right. The anchors in this folder are copies and not an anchor kept somewhere else.
