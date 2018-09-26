# pr-train 🚃

`git pr-train` helps you manage PR chains when you need to split your long PR into a sequence of smaller ones.

If you have a chain of PRs, `git pr-train`:

1. Makes sure all your branches further up the chain get updated when you modify one of them
2. Creates GitHub PRs for you with a table of contents

#### Why?

Because doing those two things manually can be (very) frustrating.

## How does it work?

You worked on a feature and you have a patch that is over 1000 SLOCs long. That's a big chunk to review. As a good citizen, you want to split the diff into multiple PRs, e.g.:

- `fred_billing-refactor_frontend_bits`
- `fred_billing-refactor_backend_bits`
- `fred/billing-refactor_tests`

We call that a _PR train_.

If you modify a branch (or e.g. merge/rebase `fred_billing-refactor_frontend_bits` on top of `master`), you'll want all the other branches to receive the change. `git pr-train` does that by merging (or rebasing) each branch into their child branch (i.e., branch 1 into branch 2, branch 2 into branch 3 etc).

If you wish, it also makes sure there is a "combined" branch (which contains the code of all subbranches and you can build it and run tests on it).

## Installation

Run `npm install -g git-pr-train@next`.

## Usage

Before using `git pr-train` for the first time, run `git pr-train --init` to create a `.pr-train.yml` file in your repo root (_please make sure to gitignore the `.pr-train.yml` file_).

The `.pr-train.yml` file contains simple configuration that describes your trains. For example, the "billing refactor" example from above would be expressed as:

```yml
trains:
  big billing refactoring:
    - fred_billing-refactor_frontend_bits
    - fred_billing-refactor_backend_bits
    - fred_billing-refactor_tests
  #
  # ...config for older trains follows...
```

With this config, `fred_billing-refactor_frontend_bits` branch will be the first one in the train and `fred_billing-refactor_tests` will be the last.

#### "Combined Branch" workflow

Sometimes, you may want to split your code into PRs that cannot be merged separately (e.g., code changes first, then tests and snapshot updates last). In those cases it might be useful to have a branch that combines code from all the subbranches - we call that a "combined branch". It points to the same commit as the last sub-branch in the train with the exception that the PR created for this branch would be based off `master` (i.e., it will contain the full diff).

The idea is that you get LGTMs for all sub-branches in the train and then the combined branch is what you merge into `master`.

If you want to use this workflow, add a combined branch to the train config like so:

```yml
trains:
  big billing refactoring:
    - fred_billing-refactor_frontend_bits
    - fred_billing-refactor_backend_bits
    - fred_billing-refactor_tests
    - fred_billing-refactor_combined:
        combined: true
  #
  # ...config for older trains follows...
```

Unlike the sub-branches, the combined branch doesn't need to exist when you run the command; `pr-train` will make sure it's created and it points to the last sub-branch in the train. Just make sure it's listed as the last branch in the train config.

## Running PR train

Run `git pr-train` in your working dir when you're on any branch that belongs to a PR train. You don't have to be on the first branch, any branch will do. Use `-r/--rebase` option if you'd like to rebase branches on top of each other rather than merge (note: you will have to push with `git pr-train -pf` in that case).

`git pr-train -p` will merge/rebase and push your updated changes to remote `origin` (configurable via `--remote` option).

### Automagically creating GitHub PRs

**Pre-requisite**: Create a `${HOME}/.pr-train` file with a single line which is your GH access token (you can create one [here](https://github.com/settings/tokens)).

Pass `--create-prs` to create GH PRs with a "content table" section. PR titles are taken from the commit message titles of each branch HEAD. You'll be promted before the PRs are created.

**Please note that re-running with `--create-prs` will overwrite the descriptions of the existing PRs (and you most likely do not want that).**
