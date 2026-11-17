# Automated OpenAPI validation

Synchronization validates the generated PR head before merging, retaining the
source release SHA, specification digest, base-revision fence, and exact-head
merge fence. The read-only verifier runs the existing generation and test checks.

A separate reporting job has only Checks write permission and records
**OpenAPI validation** on the exact tested PR head. Failure, cancellation, or a
skipped verifier records failure. Automatic merging also requires successful
reporting. No validation is inferred from an unrelated default-branch run.

This works without a new token or assuming bot pushes start workflows. GitHub
may require approval for additional PR-triggered runs created by GITHUB_TOKEN;
the synchronization pipeline executes its verifier explicitly. When configuring
future branch rules, use this check for generated updates and provide equivalent
validation for ordinary contributor PRs before requiring it repository-wide.

Validation performed after merging and the existing explicit reusable-workflow
or workflow-dispatch publishing path remain in place. Recording a result does
not grant the verifier write access or enable new branch rules.
