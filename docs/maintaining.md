# Maintaining PrintBench

## Main branch

Changes go through a pull request. Require the `verify` and `docker` checks from
GitHub Actions and an up-to-date branch before merging. Resolve review threads.
These requirements apply to administrators too; force pushes and branch deletion
are blocked. Keep the check names stable, or update branch protection when
renaming jobs. Release publication is not a required PR check.

There is currently one collaborator. No approving review is required, so the
maintainer can merge their own PR after CI passes. Add a reviewer requirement
and CODEOWNERS when another willing reviewer with write access is available.
A CODEOWNERS entry for the sole maintainer would add no independent review.

Protection was configured through GitHub's
[branch protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection).
Confirm the current state under Settings → Branches before changing it.

The companion docs repository has no observed CI checks yet. After landing its
documentation workflow and seeing `verify` pass, protect its main branch with
that check. Do not require an absent check while introducing the workflow.

## Issue triage

Use a small working set of labels:

| Label               | When to use it                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| `bug`               | Broken behaviour with a report to investigate.                               |
| `enhancement`       | Proposed new or changed behaviour.                                           |
| `documentation`     | Documentation changes.                                                       |
| `question`          | Setup or usage help.                                                         |
| `needs information` | Waiting for reproduction steps, logs or clarification. Remove when answered. |
| `help wanted`       | A scoped task where contributions are welcome.                               |
| `good first issue`  | A small task with clear acceptance criteria and setup guidance.              |

Existing dependency/ecosystem labels remain useful for automated PRs. Keep
`approved`, `changes needed` and `do not merge` for the existing review process;
`approved` records acceptance of scope and does not waive CI. Check these labels
before merging. `do not merge` is a manual hold, not an automated merge gate.

For each new issue, check for duplicates, choose its type, and ask for any
missing reproduction information. Confirm bugs against the supported release.
Do not label work `good first issue` until its scope and expected result are clear.
Close duplicates with a link; explain completed or declined requests. Avoid
automatic stale closure of unresolved bugs. A label is not a delivery promise.

## Support and security

Public setup questions use the question issue form and [SUPPORT.md](../SUPPORT.md).
Discussions remain disabled while Issues provide a single public help route.
Private vulnerability reporting is enabled on the app repository; reports go
through [SECURITY.md](../SECURITY.md). Conduct reports use the separate contact
in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).

Dependabot security updates are enabled. Secret scanning and push protection
were disabled at the task 7 audit; review their availability in Settings →
Advanced Security separately from the branch and triage settings.
