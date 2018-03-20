# pr-train 🚃
Small (but helpful) script to help with PR splitting

[![asciicast](https://asciinema.org/a/wu9OXFr0zyrtv1P3DX5ntiaLs.png)](https://asciinema.org/a/wu9OXFr0zyrtv1P3DX5ntiaLs)

## How does this thing work?
Note: We expect your branches to follow this simple naming scheme: `your-name/brief-feature-description/[0-9]+(/optional-part)`, e.g. `fred/billing-refactor/1/frontend-changes`.

#### Example:
Say you want to split your work into multiple PRs. You create a chain of PRs (or a "PR train") looking like this:
 * `fred/billing-refactor/1/frontend`
 * `fred/billing-refactor/2/backend`
 * `fred/billing-refactor/3/tests`

Now if you modify a branch, you will want all the subsequent branches to receive the change.

`pr-train` does just that for you. It takes all the subbranches, sorts them and merges each into their child branch (i.e., branch 1 into branch 2, branch 2 into branch 3 etc).

It also makes sure there is a `fred/billing-refactor/combined` branch and all the other sub-branches are merged into it (just in case you need to run linting etc that you don't want to put into the last branch).
