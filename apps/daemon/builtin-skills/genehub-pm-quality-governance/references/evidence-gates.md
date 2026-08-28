# Evidence gates

## Work package contract

Record: package id, intended outcome, explicit exclusions, input commit/artifact, assigned Agent Space and WorkSession, writable branch/worktree, dependencies, acceptance checks, and risk level.

## Candidate record

Record immutable facts rather than paths alone:

- repository identity;
- commit SHA and tree SHA;
- relevant Space source commit and Builder lock digest;
- mechanical test/build commands and results;
- produced Demo/artifact digest;
- known limitations.

## Review verdict

Bind the verdict to the same candidate facts and Intent revision. Require:

- reviewer WorkSession and independent Agent Space;
- checks performed and evidence inspected;
- blocking findings and non-blocking risks;
- `pass` or `fail` with no ambiguous “looks good” state.

Any candidate, acceptance, dependency, Skill, or Builder-lock change expires the verdict. Integration may proceed only when every required gate references the current immutable candidate.
