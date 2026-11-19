/**
 * What a restart keeps and what it cannot (R7, D-074). One text, used by the command line, the receipt and
 * the documents, so none of them says more than the others. A restart is a fork from a checkpoint. It does
 * not reproduce the old run.
 */

export const FORK_KEEPS: readonly string[] = [
  "The files of the checkpoint, exactly. The new worktree is built from the snapshot, and its tree is compared with the tree of the checkpoint before anything runs.",
  "The conversation up to the last message of the worker at that checkpoint that held no tool call, when one was recorded. The old session is not changed.",
  "The charter and the ledger. The reason of the restart becomes a drift rule of a new charter version, and an instruction to the worker. The old branch, its checkpoints and its scores stay as they are.",
  "The run budget. Spend on the new branch counts against the same limits.",
];

export const FORK_CANNOT: readonly string[] = [
  "Reproduce the old run. The worker is a model and does not repeat itself, so the new branch can go a different way from the same state.",
  "Restore anything outside the workspace: a database server, a service, a file in another folder, a package installed on the machine, or a program that is still running.",
  "Undo an irreversible action. A checkpoint taken after one is marked record only and a restart from it is refused.",
  "Keep the git history or any folder that was empty at the checkpoint. A folder of the allowed paths is created again, and no other empty folder is.",
  "Make the memory of the worker match the files. The conversation can stop earlier than the files of the checkpoint, so the worker is told to check the files before it relies on what it remembers.",
  "Carry an approval over. An approval is bound to the branch it was given on, so a held action is held again on the new branch and needs a new approval.",
];

export const FORK_STATEMENT = `A restart is a fork, not a replay. It keeps: ${FORK_KEEPS.join(" ")} It cannot: ${FORK_CANNOT.join(" ")}`;
