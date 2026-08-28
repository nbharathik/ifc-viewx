# Feature-frozen refactoring

The refactor may change internal structure, but not observable product behavior.
Its objective is fewer duplicated concepts and clearer ownership. File count and
line count are measurements, not targets.

## Refactor contract

- Keep every browser, extension, Local Studio, CLI, REST, MCP, offline and export workflow.
- Keep the public SDK and stored data compatible.
- Add a characterization test before changing behavior that is not already protected.
- Treat dynamic imports, plugin manifests, workers and Python entry points as live code.
- Make one bounded conceptual change at a time and run the proportional gate.
- Do not trade disposal, cancellation, validation or sandbox checks for shorter code.
- Do not add a runtime dependency solely to support refactoring.

The [feature inventory](features.md) is the human acceptance list. The generated
[`public-contracts.json`](public-contracts.json) and the emitted
[`sdk-type-contracts.json`](sdk-type-contracts.json) are its machine-checkable
companions. [Verification](verification.md) describes the commands, metrics
and publication gate. The [review report](report.md) records the final evidence
and remaining publication limitations.

## Acceptance rule

A refactor passes only when the relevant feature rows still pass, the public
contract snapshot is either unchanged or reviewed, no new dependency boundary
violation appears, and measured performance remains within the agreed budget.
Deleting code is not evidence that the implementation became simpler.
