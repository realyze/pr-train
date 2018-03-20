# pr-train 🚃
Small (but helpful) script to help with PR splitting

[![asciicast](https://asciinema.org/a/wu9OXFr0zyrtv1P3DX5ntiaLs.png)](https://asciinema.org/a/wu9OXFr0zyrtv1P3DX5ntiaLs)

## How does this thing work?
Say you want to split your work into multiple PRs. You create a chain of PRs (or a "PR train") looking like this:
 * fred/my-awesome-feature/1/frontend
 * fred/my-awesome-feature/2/backend
 * fred/my-awesome-feature/3/tests

And you push those.

Now if you modify e.g. branch 1, you will want all the subsequent branches to receive the change (i.e., merge branch 1 into all the subsequent branches). `pr-train` does just that for you. And it also makes sure there is a `fred/my-awesome-feature/combined` branch and all the other sub-branches are merged into it (just in case you need to run linting etc and you don't want to put that into the last branch).
